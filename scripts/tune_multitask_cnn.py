"""Optuna hyperparameter search CLI for the multi-task TemporalWarrantCNN.

Implements the hyperparameter tuning step from
``docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md``
(§Training procedure / Optimizer):

  * **Search space.**
      ``lr`` in ``[1e-4, 1e-2]`` (log-uniform).
      ``dropout`` in ``[0.1, 0.5]`` (uniform).
      Loss-weight init: ``init_log_sigma_warrant`` and
      ``init_log_sigma_intervention`` each in ``[-1.0, 1.0]`` (uniform).
      Matches PRD wording verbatim.
  * **Trials.** ``~30`` by default; a TPESampler with a fixed sampler seed
    keeps the search reproducible.
  * **Objective.** Minimise best-val-loss from a SINGLE-seed training run via
    ``scripts.train_multitask_cnn.train_one_seed``. The full 5-seed harness
    is intentionally NOT run per trial (30 trials × 5 seeds = 150 training
    runs is too expensive); the final reported model uses the tuned
    hyperparameters with the full 5-seed harness via
    ``scripts/train_multitask_cnn.py``.
  * **Search-time budget.** Per-trial training defaults to a shorter
    schedule (``--trial-epochs 30 --trial-patience 8``) so the 30-trial
    sweep completes in reasonable wall time. Override on the CLI if the
    search budget allows the full 100/10 schedule.

Outputs (under ``--output-dir``):
  ``optuna_trials.json``  — every trial's params, value, state, and timing.
  ``best_params.json``    — the best trial's params + value + trial number,
    formatted to drop straight into ``scripts/train_multitask_cnn.py``'s
    CLI flags for the final 5-seed run.

Run:
    python -m scripts.tune_multitask_cnn --output-dir runs/tune_v1 --n-trials 30

Then run the final 5-seed training with the chosen hyperparameters:
    python -m scripts.train_multitask_cnn --output-dir runs/cnn_v1 \\
        --lr <best_lr> --dropout <best_dropout>
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import numpy as np
import torch

from server.intervention_rules import INTERVENTION_CLASSES
from server.ml.synthetic_traffic import WARRANT_NAMES_ALL
from server.ml.temporal_warrant import DEFAULT_METADATA_FEATURES
from scripts.train_multitask_cnn import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_DATA_SEED,
    DEFAULT_N_DAYS,
    DEFAULT_N_INTERSECTIONS,
    DEFAULT_N_TRAIN_INTERSECTIONS,
    DEFAULT_N_VAL_INTERSECTIONS,
    DEFAULT_WEIGHT_DECAY,
    build_synthetic_dataset,
    intersection_stratified_split,
    train_one_seed,
)


logger = logging.getLogger("tune_multitask_cnn")


# ── Defaults ─────────────────────────────────────────────────────────────────
DEFAULT_N_TRIALS = 30
DEFAULT_TRIAL_EPOCHS = 30
DEFAULT_TRIAL_PATIENCE = 8
DEFAULT_TRIAL_SEED = 0
DEFAULT_OPTUNA_SEED = 42

# Search-space bounds (PRD §Training procedure / Optimizer).
LR_MIN, LR_MAX = 1e-4, 1e-2
DROPOUT_MIN, DROPOUT_MAX = 0.1, 0.5
INIT_LOG_SIGMA_MIN, INIT_LOG_SIGMA_MAX = -1.0, 1.0


def build_objective(
    data,
    train_idx: np.ndarray,
    val_idx: np.ndarray,
    n_warrants: int,
    n_intervention_classes: int,
    *,
    trial_seed: int,
    epochs: int,
    batch_size: int,
    patience: int,
    weight_decay: float,
    device: torch.device,
):
    """Build the Optuna objective closure.

    The closure samples ``lr``, ``dropout``, and the two loss-weight inits
    from the search space, runs a single-seed training via
    ``train_one_seed`` (fixed ``trial_seed`` so trials differ only in their
    hyperparameters, not their model init), and returns the best validation
    loss for the trial.
    """

    def objective(trial) -> float:
        lr = trial.suggest_float("lr", LR_MIN, LR_MAX, log=True)
        dropout = trial.suggest_float("dropout", DROPOUT_MIN, DROPOUT_MAX)
        init_log_sigma_warrant = trial.suggest_float(
            "init_log_sigma_warrant", INIT_LOG_SIGMA_MIN, INIT_LOG_SIGMA_MAX,
        )
        init_log_sigma_intervention = trial.suggest_float(
            "init_log_sigma_intervention", INIT_LOG_SIGMA_MIN, INIT_LOG_SIGMA_MAX,
        )

        logger.info(
            "trial=%d lr=%.2e dropout=%.3f init_log_sigma_w=%.3f init_log_sigma_i=%.3f",
            trial.number, lr, dropout, init_log_sigma_warrant, init_log_sigma_intervention,
        )

        _, _, metrics, _ = train_one_seed(
            seed=trial_seed,
            data=data,
            train_idx=train_idx,
            val_idx=val_idx,
            n_warrants=n_warrants,
            n_intervention_classes=n_intervention_classes,
            epochs=epochs,
            batch_size=batch_size,
            lr=lr,
            weight_decay=weight_decay,
            dropout=dropout,
            patience=patience,
            device=device,
            init_log_sigma_warrant=init_log_sigma_warrant,
            init_log_sigma_intervention=init_log_sigma_intervention,
        )

        logger.info(
            "trial=%d best_val=%.4f @ epoch %d (ran %d epochs)",
            trial.number, metrics.best_val_loss, metrics.best_epoch, metrics.epochs_run,
        )
        return metrics.best_val_loss

    return objective


def _serialize_trial(trial) -> dict:
    """Trial → plain JSON dict (avoids depending on optuna at read time)."""
    return {
        "number": trial.number,
        "value": trial.value,
        "state": str(trial.state.name),
        "params": dict(trial.params),
        "duration_s": (
            (trial.datetime_complete - trial.datetime_start).total_seconds()
            if trial.datetime_complete and trial.datetime_start
            else None
        ),
    }


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Optuna hyperparameter search for the multi-task TemporalWarrantCNN. "
            "Searches lr, dropout, and loss-weight initialisation; minimises "
            "best validation loss on a single-seed training run per trial."
        ),
    )
    parser.add_argument(
        "--output-dir", type=Path, default=Path("runs/tune_temporal_cnn"),
        help="Directory to write the trials JSON and best-params JSON into.",
    )
    parser.add_argument("--n-trials", type=int, default=DEFAULT_N_TRIALS,
                        help="Number of Optuna trials (PRD default: ~30).")
    parser.add_argument("--trial-epochs", type=int, default=DEFAULT_TRIAL_EPOCHS,
                        help="Epochs per trial (shorter than the final run).")
    parser.add_argument("--trial-patience", type=int, default=DEFAULT_TRIAL_PATIENCE,
                        help="Early-stop patience per trial.")
    parser.add_argument("--trial-seed", type=int, default=DEFAULT_TRIAL_SEED,
                        help="Fixed training seed used for every trial.")
    parser.add_argument("--optuna-seed", type=int, default=DEFAULT_OPTUNA_SEED,
                        help="Seed for the TPE sampler (study reproducibility).")
    # Dataset / split — mirrored from train_multitask_cnn for consistency.
    parser.add_argument("--n-intersections", type=int, default=DEFAULT_N_INTERSECTIONS)
    parser.add_argument("--n-days", type=int, default=DEFAULT_N_DAYS)
    parser.add_argument("--n-train-intersections", type=int,
                        default=DEFAULT_N_TRAIN_INTERSECTIONS)
    parser.add_argument("--n-val-intersections", type=int,
                        default=DEFAULT_N_VAL_INTERSECTIONS)
    parser.add_argument("--data-seed", type=int, default=DEFAULT_DATA_SEED)
    parser.add_argument("--split-seed", type=int, default=DEFAULT_DATA_SEED)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--weight-decay", type=float, default=DEFAULT_WEIGHT_DECAY)
    parser.add_argument("--device", type=str, default="cpu")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )

    try:
        import optuna
    except ImportError as exc:
        raise SystemExit(
            "optuna is required for hyperparameter search. "
            "Install it via `pip install optuna`."
        ) from exc

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

    objective = build_objective(
        data=data,
        train_idx=train_idx,
        val_idx=val_idx,
        n_warrants=len(warrant_names),
        n_intervention_classes=len(intervention_classes),
        trial_seed=args.trial_seed,
        epochs=args.trial_epochs,
        batch_size=args.batch_size,
        patience=args.trial_patience,
        weight_decay=args.weight_decay,
        device=device,
    )

    sampler = optuna.samplers.TPESampler(seed=args.optuna_seed)
    study = optuna.create_study(direction="minimize", sampler=sampler)
    logger.info("starting Optuna study — n_trials=%d", args.n_trials)
    study.optimize(objective, n_trials=args.n_trials, show_progress_bar=False)

    args.output_dir.mkdir(parents=True, exist_ok=True)

    trials_path = args.output_dir / "optuna_trials.json"
    trials_path.write_text(json.dumps(
        {
            "args": {k: (str(v) if isinstance(v, Path) else v)
                     for k, v in vars(args).items()},
            "search_space": {
                "lr": {"low": LR_MIN, "high": LR_MAX, "log": True},
                "dropout": {"low": DROPOUT_MIN, "high": DROPOUT_MAX, "log": False},
                "init_log_sigma_warrant": {
                    "low": INIT_LOG_SIGMA_MIN, "high": INIT_LOG_SIGMA_MAX, "log": False,
                },
                "init_log_sigma_intervention": {
                    "low": INIT_LOG_SIGMA_MIN, "high": INIT_LOG_SIGMA_MAX, "log": False,
                },
            },
            "split_sizes": {
                "train": int(len(train_idx)),
                "val": int(len(val_idx)),
                "test": int(len(test_idx)),
            },
            "trials": [_serialize_trial(t) for t in study.trials],
        },
        indent=2,
    ))
    logger.info("trials → %s", trials_path)

    best_path = args.output_dir / "best_params.json"
    best_path.write_text(json.dumps(
        {
            "best_trial_number": study.best_trial.number,
            "best_value": study.best_value,
            "best_params": dict(study.best_params),
        },
        indent=2,
    ))
    logger.info(
        "best trial=%d best_val=%.4f → %s",
        study.best_trial.number, study.best_value, best_path,
    )


if __name__ == "__main__":
    main()
