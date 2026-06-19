"""Training CLI for the multi-task TemporalWarrantCNN recommender.

Implements the training procedure from
``docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md``
(§Training procedure):

  * **Dataset.** Built in-process via
    ``server.ml.synthetic_traffic.generate_labeled_sample`` — 30 synthetic
    intersections × 90 days × 2 day-types (weekday + weekend) ≈ 5,400 samples.
    Every sample is independently seeded so the dataset is fully reproducible.
  * **Splits.** Intersection-stratified using ``GroupShuffleSplit`` with
    ``groups=intersection_id`` — ~21 train / 4 val / 5 test intersections.
    Test intersections never appear in any training-related data.
  * **Loss.** ``BCEWithLogitsLoss`` (mean over 6 warrants) and class-weighted
    ``CrossEntropyLoss`` (inverse-frequency weights computed on the training
    split) composed via ``UncertaintyWeightedLoss`` from
    ``server.ml.multitask_loss``.
  * **Optimizer.** Adam, lr=1e-3, weight_decay=1e-5.
  * **Schedule.** Up to 100 epochs, batch size 64, early stopping on
    validation loss with patience=10.
  * **Multi-seed.** Trains one model per seed in ``--seeds`` (default 0..4)
    and writes one checkpoint per seed.

Each checkpoint is the dict ``model.architecture_config() | {"state_dict":
..., "training_metadata": ...}`` so ``server.ml.temporal_inference.
load_recommender`` can reconstruct it without changes. The
``training_metadata`` entry records the seed, best-val-loss epoch, final
metrics, and class weights for downstream evaluation (T14).

Run:
    python -m scripts.train_multitask_cnn --output-dir runs/cnn_v1
"""
from __future__ import annotations

import argparse
import json
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from sklearn.model_selection import GroupShuffleSplit
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from server.intervention_rules import INTERVENTION_CLASSES
from server.ml.multitask_loss import UncertaintyWeightedLoss
from server.ml.synthetic_traffic import (
    WARRANT_NAMES_ALL,
    generate_labeled_sample,
    sample_intersection_meta,
)
from server.ml.temporal_warrant import (
    DEFAULT_METADATA_FEATURES,
    TemporalWarrantCNN,
)


logger = logging.getLogger("train_multitask_cnn")


# ── Defaults (PRD §Training procedure) ───────────────────────────────────────
DEFAULT_N_INTERSECTIONS = 30
DEFAULT_N_DAYS = 90
DEFAULT_N_TRAIN_INTERSECTIONS = 21
DEFAULT_N_VAL_INTERSECTIONS = 4
# (test = total − train − val = 5 by construction)

DEFAULT_EPOCHS = 100
DEFAULT_BATCH_SIZE = 64
DEFAULT_LR = 1e-3
DEFAULT_WEIGHT_DECAY = 1e-5
DEFAULT_DROPOUT = 0.3
DEFAULT_PATIENCE = 10
DEFAULT_SEEDS: tuple[int, ...] = (0, 1, 2, 3, 4)
DEFAULT_DATA_SEED = 42


# ── Dataset generation ───────────────────────────────────────────────────────

@dataclass
class SyntheticTensors:
    """In-memory tensor bundle for the synthetic dataset.

    All tensors share leading dimension N (one row per sample).
    """

    flow: torch.Tensor                # (N, 5, 96) float32
    metadata: torch.Tensor            # (N, 5) float32
    warrants: torch.Tensor            # (N, 6) float32 — 0/1 met flags
    intervention: torch.Tensor        # (N,) int64 — class index
    intersection_id: np.ndarray       # (N,) int64 — group key for splits


def _meta_to_vector(meta, feature_order: list[str]) -> np.ndarray:
    return np.array([getattr(meta, name) for name in feature_order], dtype=np.float32)


def build_synthetic_dataset(
    n_intersections: int,
    n_days: int,
    data_seed: int,
    metadata_features: list[str],
    warrant_names: list[str],
    intervention_classes: list[str],
) -> SyntheticTensors:
    """Generate ``n_intersections × n_days × 2`` labeled samples.

    Each ``(intersection, day)`` pair contributes two samples — one weekday-
    schedule and one weekend-schedule — per the PRD's "× 2 day-types" target.
    Intersection metadata is sampled once per intersection (so all 2 × n_days
    samples from one intersection share the same metadata, which is realistic).
    """
    intervention_index = {name: i for i, name in enumerate(intervention_classes)}

    flow_rows: list[np.ndarray] = []
    meta_rows: list[np.ndarray] = []
    warrant_rows: list[list[float]] = []
    intervention_rows: list[int] = []
    intersection_ids: list[int] = []

    for intersection_id in range(n_intersections):
        # Draw the per-intersection metadata once so it is stable across days.
        meta_rng = np.random.default_rng(
            np.random.SeedSequence([data_seed, intersection_id, 0xA5]).generate_state(2)
        )
        intersection_meta = sample_intersection_meta(meta_rng)

        for day_index in range(n_days):
            for is_weekend in (False, True):
                day_rng = np.random.default_rng(
                    np.random.SeedSequence(
                        [data_seed, intersection_id, day_index, int(is_weekend)]
                    ).generate_state(2)
                )
                sample = generate_labeled_sample(
                    day_rng, meta=intersection_meta, is_weekend=is_weekend,
                )
                flow_rows.append(sample.flow_matrix.astype(np.float32, copy=False))
                meta_rows.append(_meta_to_vector(sample.meta, metadata_features))
                warrant_rows.append(
                    [float(sample.warrants[name][0]) for name in warrant_names]
                )
                intervention_rows.append(intervention_index[sample.intervention])
                intersection_ids.append(intersection_id)

    return SyntheticTensors(
        flow=torch.from_numpy(np.stack(flow_rows)),
        metadata=torch.from_numpy(np.stack(meta_rows)),
        warrants=torch.tensor(warrant_rows, dtype=torch.float32),
        intervention=torch.tensor(intervention_rows, dtype=torch.long),
        intersection_id=np.array(intersection_ids, dtype=np.int64),
    )


# ── Intersection-stratified split ────────────────────────────────────────────

def intersection_stratified_split(
    intersection_id: np.ndarray,
    n_intersections: int,
    n_train: int,
    n_val: int,
    split_seed: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Group split — returns (train_idx, val_idx, test_idx) row indices.

    Two nested ``GroupShuffleSplit`` calls (test split, then val split out of
    the train+val pool) keep every intersection in exactly one partition.
    """
    test_size = n_intersections - n_train - n_val
    if test_size <= 0:
        raise ValueError(
            f"n_train + n_val ({n_train + n_val}) must be < n_intersections "
            f"({n_intersections})"
        )

    gss_test = GroupShuffleSplit(
        n_splits=1, test_size=test_size / n_intersections, random_state=split_seed,
    )
    train_val_idx, test_idx = next(
        gss_test.split(np.zeros_like(intersection_id), groups=intersection_id)
    )

    train_val_groups = intersection_id[train_val_idx]
    gss_val = GroupShuffleSplit(
        n_splits=1,
        test_size=n_val / (n_train + n_val),
        random_state=split_seed + 1,
    )
    sub_train_idx, sub_val_idx = next(
        gss_val.split(np.zeros_like(train_val_groups), groups=train_val_groups)
    )
    train_idx = train_val_idx[sub_train_idx]
    val_idx = train_val_idx[sub_val_idx]

    return train_idx, val_idx, test_idx


# ── Class weights ────────────────────────────────────────────────────────────

def inverse_frequency_class_weights(
    intervention_labels: torch.Tensor, n_classes: int,
) -> torch.Tensor:
    """Compute per-class inverse-frequency weights for ``CrossEntropyLoss``.

    Empty classes fall back to weight 1.0 so the training does not divide by
    zero on a degenerate split.
    """
    weights = torch.ones(n_classes, dtype=torch.float32)
    counts = torch.bincount(intervention_labels, minlength=n_classes).float()
    nonzero = counts > 0
    if nonzero.any():
        total = counts[nonzero].sum()
        weights[nonzero] = total / (counts[nonzero] * n_classes)
    return weights


# ── Single-seed training ─────────────────────────────────────────────────────

@dataclass
class TrainMetrics:
    best_epoch: int
    best_val_loss: float
    final_train_loss: float
    final_val_loss: float
    epochs_run: int


def _eval_loss(
    model: TemporalWarrantCNN,
    loader: DataLoader,
    bce: nn.BCEWithLogitsLoss,
    ce: nn.CrossEntropyLoss,
    loss_module: UncertaintyWeightedLoss,
    device: torch.device,
) -> float:
    model.eval()
    loss_module.eval()
    total = 0.0
    n = 0
    with torch.no_grad():
        for flow, meta, warrants, intervention in loader:
            flow = flow.to(device)
            meta = meta.to(device)
            warrants = warrants.to(device)
            intervention = intervention.to(device)
            w_logits, i_logits = model(flow, meta)
            l = loss_module(bce(w_logits, warrants), ce(i_logits, intervention))
            total += float(l.item()) * flow.size(0)
            n += flow.size(0)
    return total / max(n, 1)


def train_one_seed(
    seed: int,
    data: SyntheticTensors,
    train_idx: np.ndarray,
    val_idx: np.ndarray,
    n_warrants: int,
    n_intervention_classes: int,
    *,
    epochs: int,
    batch_size: int,
    lr: float,
    weight_decay: float,
    dropout: float,
    patience: int,
    device: torch.device,
) -> tuple[TemporalWarrantCNN, UncertaintyWeightedLoss, TrainMetrics, torch.Tensor]:
    """Train one TemporalWarrantCNN at the given seed; return best-val checkpoint pieces."""
    torch.manual_seed(seed)
    np.random.seed(seed)

    n_input_channels = data.flow.shape[1]
    n_slots = data.flow.shape[2]
    n_metadata_features = data.metadata.shape[1]

    model = TemporalWarrantCNN(
        n_input_channels=n_input_channels,
        n_slots=n_slots,
        n_metadata_features=n_metadata_features,
        n_warrants=n_warrants,
        n_intervention_classes=n_intervention_classes,
        dropout=dropout,
    ).to(device)
    loss_module = UncertaintyWeightedLoss().to(device)

    class_weights = inverse_frequency_class_weights(
        data.intervention[train_idx], n_intervention_classes,
    ).to(device)
    bce = nn.BCEWithLogitsLoss()
    ce = nn.CrossEntropyLoss(weight=class_weights)

    optimizer = torch.optim.Adam(
        list(model.parameters()) + list(loss_module.parameters()),
        lr=lr,
        weight_decay=weight_decay,
    )

    train_set = TensorDataset(
        data.flow[train_idx],
        data.metadata[train_idx],
        data.warrants[train_idx],
        data.intervention[train_idx],
    )
    val_set = TensorDataset(
        data.flow[val_idx],
        data.metadata[val_idx],
        data.warrants[val_idx],
        data.intervention[val_idx],
    )
    train_loader = DataLoader(
        train_set,
        batch_size=batch_size,
        shuffle=True,
        drop_last=len(train_set) >= batch_size,
    )
    val_loader = DataLoader(val_set, batch_size=batch_size, shuffle=False)

    best_val = float("inf")
    best_epoch = 0
    best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
    epochs_since_improve = 0
    final_train_loss = float("nan")
    final_val_loss = float("nan")

    for epoch in range(1, epochs + 1):
        model.train()
        loss_module.train()
        running = 0.0
        n_seen = 0
        for flow, meta, warrants, intervention in train_loader:
            flow = flow.to(device)
            meta = meta.to(device)
            warrants = warrants.to(device)
            intervention = intervention.to(device)

            optimizer.zero_grad()
            w_logits, i_logits = model(flow, meta)
            loss = loss_module(
                bce(w_logits, warrants),
                ce(i_logits, intervention),
            )
            loss.backward()
            optimizer.step()
            running += float(loss.item()) * flow.size(0)
            n_seen += flow.size(0)

        train_loss = running / max(n_seen, 1)
        val_loss = _eval_loss(model, val_loader, bce, ce, loss_module, device)
        final_train_loss = train_loss
        final_val_loss = val_loss

        if val_loss < best_val - 1e-6:
            best_val = val_loss
            best_epoch = epoch
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            epochs_since_improve = 0
        else:
            epochs_since_improve += 1

        sigma_w, sigma_i = loss_module.sigmas()
        logger.info(
            "seed=%d epoch=%03d train=%.4f val=%.4f best=%.4f@%d "
            "sigma_w=%.3f sigma_i=%.3f",
            seed, epoch, train_loss, val_loss, best_val, best_epoch,
            sigma_w, sigma_i,
        )

        if epochs_since_improve >= patience:
            logger.info("seed=%d early stop at epoch=%d (patience=%d)",
                        seed, epoch, patience)
            break

    model.load_state_dict(best_state)
    metrics = TrainMetrics(
        best_epoch=best_epoch,
        best_val_loss=best_val,
        final_train_loss=final_train_loss,
        final_val_loss=final_val_loss,
        epochs_run=epoch,
    )
    return model, loss_module, metrics, class_weights.detach().cpu()


# ── Checkpoint serialisation ─────────────────────────────────────────────────

def save_checkpoint(
    path: Path,
    model: TemporalWarrantCNN,
    loss_module: UncertaintyWeightedLoss,
    metrics: TrainMetrics,
    seed: int,
    intervention_classes: list[str],
    class_weights: torch.Tensor,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sigma_w, sigma_i = loss_module.sigmas()
    ckpt = model.architecture_config() | {
        "state_dict": model.state_dict(),
        "training_metadata": {
            "seed": seed,
            "best_epoch": metrics.best_epoch,
            "best_val_loss": metrics.best_val_loss,
            "final_train_loss": metrics.final_train_loss,
            "final_val_loss": metrics.final_val_loss,
            "epochs_run": metrics.epochs_run,
            "sigma_warrant": sigma_w,
            "sigma_intervention": sigma_i,
            "intervention_class_weights": {
                name: float(w)
                for name, w in zip(intervention_classes, class_weights.tolist())
            },
        },
    }
    torch.save(ckpt, path)


# ── CLI ──────────────────────────────────────────────────────────────────────

def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train the multi-task TemporalWarrantCNN (5-seed harness).",
    )
    parser.add_argument(
        "--output-dir", type=Path, default=Path("runs/temporal_cnn"),
        help="Directory to write per-seed checkpoints into.",
    )
    parser.add_argument("--n-intersections", type=int, default=DEFAULT_N_INTERSECTIONS)
    parser.add_argument("--n-days", type=int, default=DEFAULT_N_DAYS)
    parser.add_argument("--n-train-intersections", type=int,
                        default=DEFAULT_N_TRAIN_INTERSECTIONS)
    parser.add_argument("--n-val-intersections", type=int,
                        default=DEFAULT_N_VAL_INTERSECTIONS)
    parser.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--lr", type=float, default=DEFAULT_LR)
    parser.add_argument("--weight-decay", type=float, default=DEFAULT_WEIGHT_DECAY)
    parser.add_argument("--dropout", type=float, default=DEFAULT_DROPOUT)
    parser.add_argument("--patience", type=int, default=DEFAULT_PATIENCE)
    parser.add_argument(
        "--seeds", type=int, nargs="+", default=list(DEFAULT_SEEDS),
        help="Training seeds to run (one checkpoint per seed).",
    )
    parser.add_argument("--data-seed", type=int, default=DEFAULT_DATA_SEED)
    parser.add_argument("--split-seed", type=int, default=DEFAULT_DATA_SEED)
    parser.add_argument(
        "--device", type=str, default="cpu",
        help='Torch device, e.g. "cpu" or "cuda".',
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )
    device = torch.device(args.device)

    warrant_names = list(WARRANT_NAMES_ALL)
    intervention_classes = list(INTERVENTION_CLASSES)
    metadata_features = list(DEFAULT_METADATA_FEATURES)

    logger.info(
        "building dataset: %d intersections × %d days × 2 day-types",
        args.n_intersections, args.n_days,
    )
    data = build_synthetic_dataset(
        n_intersections=args.n_intersections,
        n_days=args.n_days,
        data_seed=args.data_seed,
        metadata_features=metadata_features,
        warrant_names=warrant_names,
        intervention_classes=intervention_classes,
    )
    logger.info("dataset shape: flow=%s metadata=%s",
                tuple(data.flow.shape), tuple(data.metadata.shape))

    train_idx, val_idx, test_idx = intersection_stratified_split(
        data.intersection_id,
        n_intersections=args.n_intersections,
        n_train=args.n_train_intersections,
        n_val=args.n_val_intersections,
        split_seed=args.split_seed,
    )
    logger.info(
        "splits — train=%d val=%d test=%d (intersections: %d/%d/%d)",
        len(train_idx), len(val_idx), len(test_idx),
        len(np.unique(data.intersection_id[train_idx])),
        len(np.unique(data.intersection_id[val_idx])),
        len(np.unique(data.intersection_id[test_idx])),
    )

    summary: list[dict] = []
    for seed in args.seeds:
        logger.info("=== training seed=%d ===", seed)
        model, loss_module, metrics, class_weights = train_one_seed(
            seed=seed,
            data=data,
            train_idx=train_idx,
            val_idx=val_idx,
            n_warrants=len(warrant_names),
            n_intervention_classes=len(intervention_classes),
            epochs=args.epochs,
            batch_size=args.batch_size,
            lr=args.lr,
            weight_decay=args.weight_decay,
            dropout=args.dropout,
            patience=args.patience,
            device=device,
        )
        ckpt_path = args.output_dir / f"temporal_cnn_seed{seed}.pt"
        save_checkpoint(
            ckpt_path, model, loss_module, metrics, seed,
            intervention_classes, class_weights,
        )
        logger.info(
            "saved seed=%d checkpoint → %s (best_val=%.4f @ epoch %d)",
            seed, ckpt_path, metrics.best_val_loss, metrics.best_epoch,
        )
        summary.append({
            "seed": seed,
            "checkpoint": str(ckpt_path),
            "best_epoch": metrics.best_epoch,
            "best_val_loss": metrics.best_val_loss,
            "final_train_loss": metrics.final_train_loss,
            "final_val_loss": metrics.final_val_loss,
            "epochs_run": metrics.epochs_run,
        })

    summary_path = args.output_dir / "training_summary.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(
        {
            "args": {k: (str(v) if isinstance(v, Path) else v)
                     for k, v in vars(args).items()},
            "split_sizes": {
                "train": int(len(train_idx)),
                "val": int(len(val_idx)),
                "test": int(len(test_idx)),
            },
            "per_seed": summary,
        },
        indent=2,
    ))
    logger.info("training summary → %s", summary_path)


if __name__ == "__main__":
    main()
