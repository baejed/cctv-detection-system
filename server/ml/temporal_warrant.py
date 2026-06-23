"""TemporalWarrantCNN - multi-task 1D-CNN model definition.

Implements the algorithmic centerpiece described in
`docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md`
(§Implementation Decisions / Algorithmic centerpiece):

  * **Inputs.** A ``(5, 96)`` channels-first flow timeseries (4 vehicle
    approaches + 1 pedestrian channel) plus a 5-element intersection metadata
    vector ``(major_lanes, minor_lanes, posted_speed_kph, is_signalized,
    n_approaches)``.
  * **Backbone.** Three 1D conv blocks with channel widths 32 → 64 → 128,
    kernel size 5, BatchNorm, ReLU. MaxPool(2) after the first two blocks;
    AdaptiveAvgPool(1) after the third (the "temporal flatten").
  * **Late-fused metadata branch.** Linear(5 → 16) + ReLU, concatenated with
    the 128-dim temporal features (144 dims total) before the shared dense.
  * **Shared head.** Linear(144 → 64) + ReLU.
  * **Task heads.** A 6-dim warrant head (multi-label) and a 3-dim
    intervention head (multi-class). Sigmoid / softmax are applied at
    inference time (``server.ml.temporal_inference``), **not** in the model,
    so the raw logits flow into ``BCEWithLogitsLoss`` /
    ``CrossEntropyLoss`` during training.
  * **Regularisation.** Dropout 0.3 after the temporal flatten and after the
    shared dense (PRD §Training procedure / Regularization).

The forward signature is ``forward(flow, metadata) -> (warrant_logits,
intervention_logits)`` so callers can fold both heads into the multi-task
loss with one call.

Checkpointing convention mirrors ``server.ml.model.WarrantMLP``: every
architectural hyperparameter is stored as an instance attribute so the
training CLI can persist them alongside ``state_dict`` and the inference
loader can reconstruct the exact architecture from the checkpoint.

Parameter count (default config, kernel_size=5):
    conv1 (5 → 32):      832 conv + 64 BN = 896
    conv2 (32 → 64):  10,304 conv + 128 BN = 10,432
    conv3 (64 → 128): 41,088 conv + 256 BN = 41,344
    metadata (5 → 16):     96
    shared (144 → 64):  9,280
    warrant head (64 → 6): 390
    intervention head (64 → 3): 195
    ─────────────────────────────
    total:            ~62,633

Slightly above the PRD's "approximately 50K" target - the 64→128 conv layer
dominates and shrinking it further would compromise the receptive field
argument in the methods chapter. Documented here so the methods-chapter
parameter table is unambiguous.
"""
from __future__ import annotations

from typing import Sequence

import torch
from torch import nn


DEFAULT_WARRANT_NAMES: tuple[str, ...] = (
    "w1",
    "w2",
    "w3",
    "w4",
    "w_local_2",
    "w_local_3",
)

DEFAULT_INTERVENTION_CLASSES: tuple[str, ...] = (
    "signalize",
    "road_widening",
    "timing_only",
)

DEFAULT_METADATA_FEATURES: tuple[str, ...] = (
    "major_lanes",
    "minor_lanes",
    "posted_speed_kph",
    "is_signalized",
    "n_approaches",
)


class TemporalWarrantCNN(nn.Module):
    """Multi-task 1D-CNN with late-fused intersection metadata.

    Args:
        n_input_channels: Number of flow channels (default 5 = 4 vehicle
            approaches + 1 pedestrian).
        n_slots: Number of 15-min slots per day (default 96 = 24 hr).
        n_metadata_features: Number of intersection metadata scalars
            (default 5, matching DEFAULT_METADATA_FEATURES).
        conv_channels: Channel widths for the three conv blocks
            (default (32, 64, 128)).
        kernel_size: Conv1d kernel size, applied with "same" padding
            (default 5).
        metadata_hidden: Output width of the metadata branch (default 16).
        shared_hidden: Width of the shared dense layer (default 64).
        n_warrants: Number of warrant outputs (default 6).
        n_intervention_classes: Number of intervention classes (default 3).
        dropout: Dropout probability after the temporal flatten and after
            the shared dense layer (default 0.3).
        warrant_names: Optional label names; stored alongside the checkpoint
            so the inference loader can name the output dict.
        intervention_classes: Optional intervention-class names; same role.
        metadata_features: Optional metadata-feature names; same role.
    """

    def __init__(
        self,
        n_input_channels: int = 5,
        n_slots: int = 96,
        n_metadata_features: int = 5,
        conv_channels: Sequence[int] = (32, 64, 128),
        kernel_size: int = 5,
        metadata_hidden: int = 16,
        shared_hidden: int = 64,
        n_warrants: int = 6,
        n_intervention_classes: int = 3,
        dropout: float = 0.3,
        warrant_names: Sequence[str] | None = None,
        intervention_classes: Sequence[str] | None = None,
        metadata_features: Sequence[str] | None = None,
    ) -> None:
        super().__init__()

        conv_channels = tuple(conv_channels)
        if len(conv_channels) != 3:
            raise ValueError(
                f"conv_channels must have exactly 3 widths (got {len(conv_channels)})"
            )

        self.n_input_channels = n_input_channels
        self.n_slots = n_slots
        self.n_metadata_features = n_metadata_features
        self.conv_channels = conv_channels
        self.kernel_size = kernel_size
        self.metadata_hidden = metadata_hidden
        self.shared_hidden = shared_hidden
        self.n_warrants = n_warrants
        self.n_intervention_classes = n_intervention_classes
        self.dropout_rate = dropout
        self.warrant_names = (
            list(warrant_names) if warrant_names is not None else list(DEFAULT_WARRANT_NAMES)
        )
        self.intervention_classes = (
            list(intervention_classes)
            if intervention_classes is not None
            else list(DEFAULT_INTERVENTION_CLASSES)
        )
        self.metadata_features = (
            list(metadata_features)
            if metadata_features is not None
            else list(DEFAULT_METADATA_FEATURES)
        )

        c1, c2, c3 = conv_channels
        padding = kernel_size // 2

        self.conv_block_1 = nn.Sequential(
            nn.Conv1d(n_input_channels, c1, kernel_size, padding=padding),
            nn.BatchNorm1d(c1),
            nn.ReLU(inplace=True),
            nn.MaxPool1d(2),
        )
        self.conv_block_2 = nn.Sequential(
            nn.Conv1d(c1, c2, kernel_size, padding=padding),
            nn.BatchNorm1d(c2),
            nn.ReLU(inplace=True),
            nn.MaxPool1d(2),
        )
        self.conv_block_3 = nn.Sequential(
            nn.Conv1d(c2, c3, kernel_size, padding=padding),
            nn.BatchNorm1d(c3),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool1d(1),
        )

        self.flatten_dropout = nn.Dropout(dropout)

        self.metadata_branch = nn.Sequential(
            nn.Linear(n_metadata_features, metadata_hidden),
            nn.ReLU(inplace=True),
        )

        self.shared_dense = nn.Sequential(
            nn.Linear(c3 + metadata_hidden, shared_hidden),
            nn.ReLU(inplace=True),
        )
        self.shared_dropout = nn.Dropout(dropout)

        self.warrant_head = nn.Linear(shared_hidden, n_warrants)
        self.intervention_head = nn.Linear(shared_hidden, n_intervention_classes)

    def forward(
        self, flow: torch.Tensor, metadata: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Run the multi-task forward pass.

        Args:
            flow: ``(B, n_input_channels, n_slots)`` float tensor.
            metadata: ``(B, n_metadata_features)`` float tensor.

        Returns:
            ``(warrant_logits, intervention_logits)`` - both raw logits,
            shapes ``(B, n_warrants)`` and ``(B, n_intervention_classes)``.
        """
        x = self.conv_block_1(flow)
        x = self.conv_block_2(x)
        x = self.conv_block_3(x).squeeze(-1)
        x = self.flatten_dropout(x)

        m = self.metadata_branch(metadata)

        z = torch.cat([x, m], dim=1)
        z = self.shared_dense(z)
        z = self.shared_dropout(z)

        return self.warrant_head(z), self.intervention_head(z)

    def architecture_config(self) -> dict:
        """Return the architectural hyperparameters for checkpoint storage.

        Mirrors the ``WarrantMLP`` checkpoint pattern: the training CLI
        saves this dict alongside ``state_dict`` so the inference loader
        can reconstruct the exact architecture.
        """
        return {
            "n_input_channels": self.n_input_channels,
            "n_slots": self.n_slots,
            "n_metadata_features": self.n_metadata_features,
            "conv_channels": self.conv_channels,
            "kernel_size": self.kernel_size,
            "metadata_hidden": self.metadata_hidden,
            "shared_hidden": self.shared_hidden,
            "n_warrants": self.n_warrants,
            "n_intervention_classes": self.n_intervention_classes,
            "dropout": self.dropout_rate,
            "warrant_names": list(self.warrant_names),
            "intervention_classes": list(self.intervention_classes),
            "metadata_features": list(self.metadata_features),
        }
