"""Evaluation + Grad-CAM CLI for the multi-task TemporalWarrantCNN.

Implements the evaluation harness called for in
``docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md``
(§Testing Decisions / "End-to-end evaluation harness as a 'test' of the
trained model"):

  * **Multi-seed mean ± std per-warrant AUC + F1** on the held-out
    intersection-stratified test split (PRD §Results-chapter requirement #1).
  * **Intervention confusion matrix** with per-class precision / recall / F1
    averaged across seeds, plus the summed confusion matrix for the methods
    chapter (PRD §Results-chapter requirement #2).
  * **Ablation table** - uncertainty-weighted vs. equal-weighted multi-task
    loss. Driven by ``--ablation-dir``; computes per-warrant paired t-tests
    over the seed-axis AUC values (PRD §Results-chapter requirement #3).
  * **Grad-CAM saliency** maps over the input timeseries for a handful of
    test samples per warrant + intervention class (PRD §Results-chapter
    requirement / §Implementation Decisions interpretability). Maps are
    written to a single ``.npz`` so the methods-chapter author can plot
    them offline with matplotlib (deliberately not a runtime dep).

The script is a consumer of checkpoints emitted by ``scripts.train_multitask_cnn``
(T12). The dataset + split are reconstructed deterministically from the
``training_summary.json`` written alongside those checkpoints, so the test
split the script evaluates on is bit-for-bit identical to the one held out
during training. ``--ignore-training-summary`` falls back to CLI flags for
ad-hoc evaluations on a different split.

Outputs (all under ``--output-dir``):
  ``metrics_main.json``         per-seed + aggregated metrics for ``--model-dir``.
  ``metrics_ablation.json``     same, for ``--ablation-dir`` (only if provided).
  ``comparison.json``           per-warrant paired t-test main vs. ablation.
  ``saliency/gradcam_seed*.npz``  Grad-CAM maps + the source samples.
  ``evaluation_summary.json``   top-level summary tying everything together.

Run:
    python -m scripts.evaluate_multitask_cnn \\
        --model-dir runs/cnn_v1 --output-dir runs/cnn_v1/eval

Optional ablation:
    python -m scripts.train_multitask_cnn --output-dir runs/cnn_v1_equal \\
        --loss-type equal
    python -m scripts.evaluate_multitask_cnn \\
        --model-dir runs/cnn_v1 --ablation-dir runs/cnn_v1_equal \\
        --output-dir runs/cnn_v1/eval
"""
from __future__ import annotations

import argparse
import json
import logging
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import (
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
    roc_auc_score,
)

from server.intervention_rules import INTERVENTION_CLASSES
from server.ml.synthetic_traffic import WARRANT_NAMES_ALL
from server.ml.temporal_inference import RecommenderArtifacts, load_recommender
from server.ml.temporal_warrant import DEFAULT_METADATA_FEATURES, TemporalWarrantCNN
from scripts.train_multitask_cnn import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_DATA_SEED,
    DEFAULT_N_DAYS,
    DEFAULT_N_INTERSECTIONS,
    DEFAULT_N_TRAIN_INTERSECTIONS,
    DEFAULT_N_VAL_INTERSECTIONS,
    SyntheticTensors,
    build_synthetic_dataset,
    intersection_stratified_split,
)


logger = logging.getLogger("evaluate_multitask_cnn")


DEFAULT_SALIENCY_SAMPLES = 6
CHECKPOINT_GLOB = "temporal_cnn_seed*.pt"


# ── Per-seed metric containers ───────────────────────────────────────────────

@dataclass
class WarrantMetrics:
    name: str
    auc: float | None
    f1: float
    positive_rate: float


@dataclass
class InterventionMetrics:
    classes: list[str]
    confusion_matrix: list[list[int]]
    per_class_precision: dict[str, float]
    per_class_recall: dict[str, float]
    per_class_f1: dict[str, float]
    accuracy: float
    macro_f1: float


@dataclass
class SeedMetrics:
    seed: int
    checkpoint: str
    warrants: list[WarrantMetrics]
    intervention: InterventionMetrics


# ── Checkpoint discovery ─────────────────────────────────────────────────────

def _seed_from_path(path: Path) -> int:
    """Extract the integer seed from a ``temporal_cnn_seedN.pt`` filename."""
    stem = path.stem
    prefix = "temporal_cnn_seed"
    if not stem.startswith(prefix):
        raise ValueError(f"unexpected checkpoint filename: {path.name!r}")
    return int(stem[len(prefix):])


def list_seed_checkpoints(model_dir: Path) -> list[Path]:
    """Return all ``temporal_cnn_seed*.pt`` checkpoints under ``model_dir``.

    Sorted by seed integer (not lexicographically) so ``seed=10`` doesn't sort
    before ``seed=2`` - matters when the methods-chapter author runs more than
    ten seeds.
    """
    if not model_dir.is_dir():
        raise FileNotFoundError(f"model dir not found: {model_dir}")
    paths = sorted(model_dir.glob(CHECKPOINT_GLOB), key=_seed_from_path)
    if not paths:
        raise FileNotFoundError(
            f"no {CHECKPOINT_GLOB} under {model_dir}"
        )
    return paths


# ── Prediction collection ────────────────────────────────────────────────────

def collect_predictions(
    artifacts: RecommenderArtifacts,
    flow: torch.Tensor,
    metadata: torch.Tensor,
    batch_size: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Run a single model over the test tensors in eval mode.

    Returns ``(warrant_probs (N, 6), intervention_probs (N, 3),
    intervention_preds (N,))``. ``flow``/``metadata`` must already live on the
    same device as the model.
    """
    model = artifacts.model
    model.eval()
    warrant_chunks: list[np.ndarray] = []
    intervention_chunks: list[np.ndarray] = []
    n = flow.size(0)
    with torch.no_grad():
        for start in range(0, n, batch_size):
            end = min(start + batch_size, n)
            w_logits, i_logits = model(flow[start:end], metadata[start:end])
            warrant_chunks.append(torch.sigmoid(w_logits).cpu().numpy())
            intervention_chunks.append(torch.softmax(i_logits, dim=-1).cpu().numpy())
    warrant_probs = np.concatenate(warrant_chunks, axis=0)
    intervention_probs = np.concatenate(intervention_chunks, axis=0)
    intervention_preds = intervention_probs.argmax(axis=1)
    return warrant_probs, intervention_probs, intervention_preds


# ── Metric computation (per seed) ────────────────────────────────────────────

def evaluate_warrants(
    warrant_probs: np.ndarray,
    warrant_targets: np.ndarray,
    warrant_names: list[str],
    threshold: float = 0.5,
) -> list[WarrantMetrics]:
    """Per-warrant AUC + F1 + positive rate on the held-out test split.

    AUC is set to ``None`` for warrants with single-class targets (all-0 or
    all-1 across the test set), which can happen on small smoke-test splits
    or on rare local warrants.
    """
    metrics: list[WarrantMetrics] = []
    n_samples = int(warrant_targets.shape[0])
    for j, name in enumerate(warrant_names):
        targets = warrant_targets[:, j].astype(int)
        probs = warrant_probs[:, j]
        positives = int(targets.sum())
        positive_rate = positives / n_samples if n_samples else 0.0
        if positives == 0 or positives == n_samples:
            auc: float | None = None
        else:
            auc = float(roc_auc_score(targets, probs))
        predicted = (probs >= threshold).astype(int)
        f1 = float(f1_score(targets, predicted, zero_division=0))
        metrics.append(WarrantMetrics(
            name=name, auc=auc, f1=f1, positive_rate=positive_rate,
        ))
    return metrics


def evaluate_intervention(
    intervention_preds: np.ndarray,
    intervention_targets: np.ndarray,
    intervention_classes: list[str],
) -> InterventionMetrics:
    """Confusion matrix + per-class precision/recall/F1 + accuracy + macro F1."""
    labels = list(range(len(intervention_classes)))
    cm = confusion_matrix(intervention_targets, intervention_preds, labels=labels)
    precision, recall, f1, _support = precision_recall_fscore_support(
        intervention_targets, intervention_preds,
        labels=labels, zero_division=0,
    )
    accuracy = float((intervention_preds == intervention_targets).mean()) \
        if intervention_targets.size else 0.0
    macro_f1 = float(f1.mean())
    return InterventionMetrics(
        classes=list(intervention_classes),
        confusion_matrix=cm.tolist(),
        per_class_precision={
            name: float(p) for name, p in zip(intervention_classes, precision)
        },
        per_class_recall={
            name: float(r) for name, r in zip(intervention_classes, recall)
        },
        per_class_f1={
            name: float(v) for name, v in zip(intervention_classes, f1)
        },
        accuracy=accuracy,
        macro_f1=macro_f1,
    )


# ── Cross-seed aggregation ───────────────────────────────────────────────────

def _std(values: list[float]) -> float:
    """Sample stdev with one-seed safety fallback (returns 0.0)."""
    if len(values) <= 1:
        return 0.0
    return float(np.std(values, ddof=1))


def aggregate_warrant_metrics(
    per_seed: list[list[WarrantMetrics]],
    warrant_names: list[str],
) -> dict[str, dict[str, float | None | int]]:
    """Mean ± std per-warrant across seeds.

    AUC ``None`` entries (single-class targets) are dropped from the mean to
    avoid biasing the average toward 0.0; the seed count contributing to the
    AUC mean is recorded as ``auc_n_seeds`` so the methods-chapter table can
    flag warrants with incomplete coverage.
    """
    aggregated: dict[str, dict[str, float | None | int]] = {}
    for j, name in enumerate(warrant_names):
        auc_values = [s[j].auc for s in per_seed if s[j].auc is not None]
        f1_values = [s[j].f1 for s in per_seed]
        positive_rates = [s[j].positive_rate for s in per_seed]
        aggregated[name] = {
            "auc_mean": float(np.mean(auc_values)) if auc_values else None,
            "auc_std": _std([float(v) for v in auc_values]),
            "auc_n_seeds": len(auc_values),
            "f1_mean": float(np.mean(f1_values)) if f1_values else 0.0,
            "f1_std": _std([float(v) for v in f1_values]),
            "positive_rate_mean": float(np.mean(positive_rates))
                if positive_rates else 0.0,
        }
    return aggregated


def aggregate_intervention_metrics(
    per_seed: list[InterventionMetrics],
) -> dict:
    """Mean ± std accuracy + macro F1 + per-class P/R/F1 plus summed CM."""
    accuracies = [m.accuracy for m in per_seed]
    macro_f1s = [m.macro_f1 for m in per_seed]
    classes = per_seed[0].classes
    cms = np.stack([np.array(m.confusion_matrix) for m in per_seed], axis=0)
    summed_cm = cms.sum(axis=0)

    def _mean_per_class(field: str) -> dict[str, float]:
        return {
            cls: float(np.mean([getattr(m, field)[cls] for m in per_seed]))
            for cls in classes
        }

    def _std_per_class(field: str) -> dict[str, float]:
        return {
            cls: _std([float(getattr(m, field)[cls]) for m in per_seed])
            for cls in classes
        }

    return {
        "classes": classes,
        "accuracy_mean": float(np.mean(accuracies)),
        "accuracy_std": _std(accuracies),
        "macro_f1_mean": float(np.mean(macro_f1s)),
        "macro_f1_std": _std(macro_f1s),
        "per_class_precision_mean": _mean_per_class("per_class_precision"),
        "per_class_precision_std": _std_per_class("per_class_precision"),
        "per_class_recall_mean": _mean_per_class("per_class_recall"),
        "per_class_recall_std": _std_per_class("per_class_recall"),
        "per_class_f1_mean": _mean_per_class("per_class_f1"),
        "per_class_f1_std": _std_per_class("per_class_f1"),
        "summed_confusion_matrix": summed_cm.tolist(),
    }


# ── Whole-directory evaluation ───────────────────────────────────────────────

def evaluate_model_dir(
    model_dir: Path,
    data: SyntheticTensors,
    test_idx: np.ndarray,
    warrant_names: list[str],
    intervention_classes: list[str],
    batch_size: int,
    device: torch.device,
) -> tuple[list[SeedMetrics], dict, dict]:
    """Load every seed checkpoint under ``model_dir`` and evaluate on the test split.

    Returns ``(per_seed_metrics, aggregated_warrants, aggregated_intervention)``.
    """
    seed_paths = list_seed_checkpoints(model_dir)
    flow_test = data.flow[test_idx].to(device)
    metadata_test = data.metadata[test_idx].to(device)
    warrant_targets = data.warrants[test_idx].cpu().numpy()
    intervention_targets = data.intervention[test_idx].cpu().numpy()

    per_seed: list[SeedMetrics] = []
    for path in seed_paths:
        seed = _seed_from_path(path)
        artifacts = load_recommender(path)
        artifacts.model.to(device)
        warrant_probs, _intervention_probs, intervention_preds = collect_predictions(
            artifacts, flow_test, metadata_test, batch_size=batch_size,
        )
        warrant_metrics = evaluate_warrants(
            warrant_probs, warrant_targets, warrant_names,
        )
        intervention_metrics = evaluate_intervention(
            intervention_preds, intervention_targets, intervention_classes,
        )
        per_seed.append(SeedMetrics(
            seed=seed,
            checkpoint=str(path),
            warrants=warrant_metrics,
            intervention=intervention_metrics,
        ))
        logger.info(
            "seed=%d ckpt=%s intervention_acc=%.4f macro_f1=%.4f",
            seed, path.name,
            intervention_metrics.accuracy, intervention_metrics.macro_f1,
        )

    aggregated_warrants = aggregate_warrant_metrics(
        [m.warrants for m in per_seed], warrant_names,
    )
    aggregated_intervention = aggregate_intervention_metrics(
        [m.intervention for m in per_seed],
    )
    return per_seed, aggregated_warrants, aggregated_intervention


# ── Grad-CAM (1D) ────────────────────────────────────────────────────────────

class GradCAM1D:
    """1D Grad-CAM over ``conv_block_3``'s pre-pool ReLU activations.

    ``TemporalWarrantCNN.conv_block_3`` is ``[Conv1d, BatchNorm1d, ReLU,
    AdaptiveAvgPool1d(1)]``. We hook ``conv_block_3[2]`` (the ReLU) so the
    captured activations have shape ``(B, 128, T')`` with ``T'`` aligned to
    the input timeseries (24 slots after two MaxPools), rather than the
    pooled-down ``(B, 128, 1)`` after the AdaptiveAvgPool. The output map is
    upsampled back to 96 slots so it overlays the input cleanly in
    methods-chapter figures.

    The gradient is captured via ``tensor.register_hook`` on the ReLU's
    output rather than ``module.register_full_backward_hook``: the model's
    ReLU is constructed with ``inplace=True``, which makes its output a
    view that autograd does not allow the full backward hook to wrap (the
    BackwardHookFunction would observe the view being modified in place).
    The tensor-level hook adds no autograd op, only a callback, so it
    sidesteps that constraint without requiring us to toggle the inplace
    flag at evaluation time.
    """

    def __init__(self, model: TemporalWarrantCNN) -> None:
        self.model = model
        self.target_layer = model.conv_block_3[2]
        self.activations: torch.Tensor | None = None
        self.gradients: torch.Tensor | None = None
        self._forward_handle = None

    def __enter__(self) -> "GradCAM1D":
        self._forward_handle = self.target_layer.register_forward_hook(
            self._forward_hook,
        )
        return self

    def __exit__(self, *_exc) -> None:
        if self._forward_handle is not None:
            self._forward_handle.remove()
            self._forward_handle = None

    def _forward_hook(self, _module, _inputs, output) -> None:
        self.activations = output.detach().clone()

        def _grad_hook(grad: torch.Tensor) -> None:
            self.gradients = grad.detach().clone()

        output.register_hook(_grad_hook)

    def compute(
        self,
        flow: torch.Tensor,
        metadata: torch.Tensor,
        head: str,
        index: int,
    ) -> np.ndarray:
        """Return ``(B, n_slots)`` Grad-CAM map for one ``(head, index)``."""
        self.model.eval()
        warrant_logits, intervention_logits = self.model(flow, metadata)
        if head == "warrant":
            target = warrant_logits[:, index].sum()
        elif head == "intervention":
            target = intervention_logits[:, index].sum()
        else:
            raise ValueError(f"unknown head: {head!r}")
        self.model.zero_grad(set_to_none=True)
        target.backward()
        assert self.activations is not None and self.gradients is not None
        # (B, C, T') → (B, T') by channel-mean weighting + summation.
        weights = self.gradients.mean(dim=2, keepdim=True)
        cam = (weights * self.activations).sum(dim=1)
        cam = torch.relu(cam)
        # Upsample (T') → n_slots for plotting alignment.
        cam = torch.nn.functional.interpolate(
            cam.unsqueeze(1), size=flow.shape[2],
            mode="linear", align_corners=False,
        ).squeeze(1)
        # Per-row [0, 1] normalisation so warrants with different magnitudes
        # are visually comparable in the methods-chapter figure.
        max_per_row = cam.amax(dim=1, keepdim=True).clamp_min(1e-8)
        cam = cam / max_per_row
        return cam.detach().cpu().numpy()


def compute_saliency(
    model_path: Path,
    data: SyntheticTensors,
    test_idx: np.ndarray,
    warrant_names: list[str],
    intervention_classes: list[str],
    n_samples: int,
    device: torch.device,
) -> dict[str, np.ndarray]:
    """Pick ``n_samples`` test rows and compute Grad-CAM for every (head, idx).

    Returns a flat dict suitable for ``np.savez``. Sample selection uses an
    evenly-spaced span across the test set rather than a random draw so the
    figures are reproducible across reruns without a separate seed.
    """
    artifacts = load_recommender(model_path)
    model = artifacts.model.to(device)
    model.eval()

    test_size = int(test_idx.size)
    if test_size == 0:
        return {}
    n = min(n_samples, test_size)
    chosen = np.linspace(0, test_size - 1, num=n, dtype=int)
    flow = data.flow[test_idx][chosen].to(device)
    metadata = data.metadata[test_idx][chosen].to(device)

    saliency: dict[str, np.ndarray] = {
        "flow": flow.detach().cpu().numpy(),
        "metadata": metadata.detach().cpu().numpy(),
        "warrant_targets": data.warrants[test_idx][chosen].cpu().numpy(),
        "intervention_targets": data.intervention[test_idx][chosen].cpu().numpy(),
        "test_row_indices": test_idx[chosen],
    }
    with GradCAM1D(model) as extractor:
        for j, name in enumerate(warrant_names):
            saliency[f"gradcam_warrant_{name}"] = extractor.compute(
                flow, metadata, head="warrant", index=j,
            )
        for k, name in enumerate(intervention_classes):
            saliency[f"gradcam_intervention_{name}"] = extractor.compute(
                flow, metadata, head="intervention", index=k,
            )
    return saliency


# ── Paired main-vs-ablation comparison ───────────────────────────────────────

def paired_ttest_main_vs_ablation(
    main_per_seed: list[list[WarrantMetrics]],
    ablation_per_seed: list[list[WarrantMetrics]],
    warrant_names: list[str],
) -> dict[str, dict]:
    """Per-warrant paired t-test on the seed-axis AUC values.

    Pairs seeds positionally: assumes ``main_per_seed[i]`` and
    ``ablation_per_seed[i]`` share the same seed integer (both runs swept
    ``{0, 1, 2, 3, 4}`` by convention). Caller must enforce the seed count
    match; this function only verifies the lengths agree.
    """
    from scipy import stats

    if len(main_per_seed) != len(ablation_per_seed):
        raise ValueError(
            f"seed count mismatch: main={len(main_per_seed)} "
            f"ablation={len(ablation_per_seed)}; cannot pair."
        )

    results: dict[str, dict] = {}
    for j, name in enumerate(warrant_names):
        main_aucs = [s[j].auc for s in main_per_seed]
        ablation_aucs = [s[j].auc for s in ablation_per_seed]
        if any(v is None for v in main_aucs + ablation_aucs):
            results[name] = {
                "main_auc_mean": None,
                "ablation_auc_mean": None,
                "delta_auc_mean": None,
                "t_statistic": None,
                "p_value": None,
                "note": "AUC undefined for >=1 seed (single-class test targets).",
            }
            continue
        main_arr = np.array(main_aucs, dtype=float)
        ablation_arr = np.array(ablation_aucs, dtype=float)
        diff = main_arr - ablation_arr
        if len(diff) < 2 or float(diff.std(ddof=1)) == 0.0:
            t_stat, p_val = None, None
        else:
            res = stats.ttest_rel(main_arr, ablation_arr)
            t_stat, p_val = float(res.statistic), float(res.pvalue)
        results[name] = {
            "main_auc_mean": float(main_arr.mean()),
            "ablation_auc_mean": float(ablation_arr.mean()),
            "delta_auc_mean": float(diff.mean()),
            "t_statistic": t_stat,
            "p_value": p_val,
        }
    return results


# ── CLI plumbing ─────────────────────────────────────────────────────────────

def _load_training_summary(model_dir: Path) -> dict | None:
    summary_path = model_dir / "training_summary.json"
    if summary_path.is_file():
        return json.loads(summary_path.read_text())
    return None


def _resolve_dataset_args(
    args: argparse.Namespace, model_dir: Path,
) -> dict:
    """Prefer dataset args from the model dir's training_summary.json.

    Falls back to CLI flags when no summary exists or when
    ``--ignore-training-summary`` is set (useful for evaluating an existing
    checkpoint against an alternate held-out split).
    """
    summary = _load_training_summary(model_dir)
    if summary is not None and not args.ignore_training_summary:
        train_args = summary.get("args", {})
        resolved = {
            "n_intersections": int(train_args.get(
                "n_intersections", args.n_intersections)),
            "n_days": int(train_args.get("n_days", args.n_days)),
            "n_train_intersections": int(train_args.get(
                "n_train_intersections", args.n_train_intersections)),
            "n_val_intersections": int(train_args.get(
                "n_val_intersections", args.n_val_intersections)),
            "data_seed": int(train_args.get("data_seed", args.data_seed)),
            "split_seed": int(train_args.get("split_seed", args.split_seed)),
        }
        logger.info(
            "dataset config from training_summary.json: %s", resolved,
        )
        return resolved
    return {
        "n_intersections": args.n_intersections,
        "n_days": args.n_days,
        "n_train_intersections": args.n_train_intersections,
        "n_val_intersections": args.n_val_intersections,
        "data_seed": args.data_seed,
        "split_seed": args.split_seed,
    }


def _seed_metrics_to_dict(metrics: SeedMetrics) -> dict:
    return {
        "seed": metrics.seed,
        "checkpoint": metrics.checkpoint,
        "warrants": [asdict(w) for w in metrics.warrants],
        "intervention": asdict(metrics.intervention),
    }


def _resolve_saliency_checkpoint(
    seed_paths: list[Path], requested: int | None,
) -> Path:
    if requested is None:
        return seed_paths[0]
    matching = [p for p in seed_paths if _seed_from_path(p) == requested]
    if not matching:
        raise SystemExit(
            f"no checkpoint for --saliency-from-seed {requested} "
            f"in {seed_paths[0].parent}"
        )
    return matching[0]


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Evaluate one or two multi-seed TemporalWarrantCNN runs: per-warrant "
            "AUC/F1 mean ± std, intervention confusion matrix, optional "
            "uncertainty-weighted vs equal-weighted ablation comparison, and "
            "Grad-CAM saliency maps."
        ),
    )
    parser.add_argument(
        "--model-dir", type=Path, required=True,
        help="Directory containing temporal_cnn_seed*.pt checkpoints to evaluate.",
    )
    parser.add_argument(
        "--output-dir", type=Path, required=True,
        help="Directory to write metrics, saliency, and the evaluation summary into.",
    )
    parser.add_argument(
        "--ablation-dir", type=Path, default=None,
        help=(
            "Optional second checkpoint directory (e.g., equal-weighted ablation "
            "runs trained via --loss-type equal). Triggers the comparison table."
        ),
    )
    parser.add_argument(
        "--saliency-samples", type=int, default=DEFAULT_SALIENCY_SAMPLES,
        help="Number of test-split rows to Grad-CAM (default: 6).",
    )
    parser.add_argument(
        "--saliency-from-seed", type=int, default=None,
        help="Which seed's checkpoint to use for Grad-CAM (default: lowest seed).",
    )
    parser.add_argument(
        "--ignore-training-summary", action="store_true",
        help=(
            "Use CLI dataset/split flags even if training_summary.json exists "
            "(skips the deterministic test-split reconstruction)."
        ),
    )
    # Dataset / split fallback args - mirror train_multitask_cnn.py defaults.
    parser.add_argument("--n-intersections", type=int, default=DEFAULT_N_INTERSECTIONS)
    parser.add_argument("--n-days", type=int, default=DEFAULT_N_DAYS)
    parser.add_argument("--n-train-intersections", type=int,
                        default=DEFAULT_N_TRAIN_INTERSECTIONS)
    parser.add_argument("--n-val-intersections", type=int,
                        default=DEFAULT_N_VAL_INTERSECTIONS)
    parser.add_argument("--data-seed", type=int, default=DEFAULT_DATA_SEED)
    parser.add_argument("--split-seed", type=int, default=DEFAULT_DATA_SEED)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--device", type=str, default="cpu")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )
    device = torch.device(args.device)

    warrant_names = list(WARRANT_NAMES_ALL)
    intervention_classes = list(INTERVENTION_CLASSES)
    metadata_features = list(DEFAULT_METADATA_FEATURES)

    dataset_args = _resolve_dataset_args(args, args.model_dir)
    logger.info(
        "building dataset: %d intersections × %d days × 2 day-types",
        dataset_args["n_intersections"], dataset_args["n_days"],
    )
    data = build_synthetic_dataset(
        n_intersections=dataset_args["n_intersections"],
        n_days=dataset_args["n_days"],
        data_seed=dataset_args["data_seed"],
        metadata_features=metadata_features,
        warrant_names=warrant_names,
        intervention_classes=intervention_classes,
    )

    train_idx, val_idx, test_idx = intersection_stratified_split(
        data.intersection_id,
        n_intersections=dataset_args["n_intersections"],
        n_train=dataset_args["n_train_intersections"],
        n_val=dataset_args["n_val_intersections"],
        split_seed=dataset_args["split_seed"],
    )
    logger.info(
        "splits - train=%d val=%d test=%d (intersections: %d/%d/%d)",
        len(train_idx), len(val_idx), len(test_idx),
        len(np.unique(data.intersection_id[train_idx])),
        len(np.unique(data.intersection_id[val_idx])),
        len(np.unique(data.intersection_id[test_idx])),
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)

    logger.info("=== evaluating main model: %s ===", args.model_dir)
    main_per_seed, main_warrants_agg, main_intervention_agg = evaluate_model_dir(
        args.model_dir, data, test_idx, warrant_names, intervention_classes,
        batch_size=args.batch_size, device=device,
    )
    main_metrics_path = args.output_dir / "metrics_main.json"
    main_metrics_path.write_text(json.dumps(
        {
            "model_dir": str(args.model_dir),
            "test_size": int(len(test_idx)),
            "per_seed": [_seed_metrics_to_dict(m) for m in main_per_seed],
            "aggregated_warrants": main_warrants_agg,
            "aggregated_intervention": main_intervention_agg,
        },
        indent=2,
    ))
    logger.info("main metrics → %s", main_metrics_path)

    comparison_payload: dict | None = None
    if args.ablation_dir is not None:
        logger.info("=== evaluating ablation: %s ===", args.ablation_dir)
        abl_per_seed, abl_warrants_agg, abl_intervention_agg = evaluate_model_dir(
            args.ablation_dir, data, test_idx, warrant_names, intervention_classes,
            batch_size=args.batch_size, device=device,
        )
        abl_metrics_path = args.output_dir / "metrics_ablation.json"
        abl_metrics_path.write_text(json.dumps(
            {
                "model_dir": str(args.ablation_dir),
                "test_size": int(len(test_idx)),
                "per_seed": [_seed_metrics_to_dict(m) for m in abl_per_seed],
                "aggregated_warrants": abl_warrants_agg,
                "aggregated_intervention": abl_intervention_agg,
            },
            indent=2,
        ))
        logger.info("ablation metrics → %s", abl_metrics_path)

        comparison_payload = paired_ttest_main_vs_ablation(
            [m.warrants for m in main_per_seed],
            [m.warrants for m in abl_per_seed],
            warrant_names,
        )
        comparison_path = args.output_dir / "comparison.json"
        comparison_path.write_text(json.dumps(comparison_payload, indent=2))
        logger.info("comparison → %s", comparison_path)

    seed_paths = list_seed_checkpoints(args.model_dir)
    saliency_ckpt = _resolve_saliency_checkpoint(
        seed_paths, args.saliency_from_seed,
    )
    logger.info("=== computing Grad-CAM saliency: %s ===", saliency_ckpt)
    saliency = compute_saliency(
        saliency_ckpt, data, test_idx, warrant_names, intervention_classes,
        n_samples=args.saliency_samples, device=device,
    )
    saliency_dir = args.output_dir / "saliency"
    saliency_dir.mkdir(parents=True, exist_ok=True)
    saliency_path = saliency_dir / (
        f"gradcam_seed{_seed_from_path(saliency_ckpt)}.npz"
    )
    np.savez(saliency_path, **saliency)
    logger.info("saliency → %s", saliency_path)

    summary_path = args.output_dir / "evaluation_summary.json"
    summary_path.write_text(json.dumps(
        {
            "args": {
                k: (str(v) if isinstance(v, Path) else v)
                for k, v in vars(args).items()
            },
            "dataset_args": dataset_args,
            "split_sizes": {
                "train": int(len(train_idx)),
                "val": int(len(val_idx)),
                "test": int(len(test_idx)),
            },
            "n_seeds_main": len(main_per_seed),
            "warrant_aggregated": main_warrants_agg,
            "intervention_aggregated": main_intervention_agg,
            "ablation_comparison": comparison_payload,
            "saliency_seed": _seed_from_path(saliency_ckpt),
            "saliency_path": str(saliency_path),
        },
        indent=2,
    ))
    logger.info("evaluation summary → %s", summary_path)


if __name__ == "__main__":
    main()
