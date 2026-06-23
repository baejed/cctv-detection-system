"""Inference helpers for the multi-task TemporalWarrantCNN recommender.

Two public functions mirror the ``server.ml.inference`` pattern used by the
scalar ``WarrantMLP`` baseline:

    load_recommender(model_path) -> RecommenderArtifacts
    predict_recommendations(artifacts, flow_matrix, metadata)
        -> RecommendationResult

``load_recommender`` reconstructs ``TemporalWarrantCNN`` from a checkpoint
dict containing the architecture config emitted by
``TemporalWarrantCNN.architecture_config()`` plus a ``state_dict`` entry.
The intersection metadata feature order is persisted on the checkpoint so
inference can vectorise the metadata dict in the same order training saw it,
even if ``DEFAULT_METADATA_FEATURES`` is later reordered.

``predict_recommendations`` is the single inference call site that the
recommendations router (T16) will switch onto: it runs one forward pass and
returns the warrant probabilities (multi-label sigmoid) together with the
intervention class string (argmax over softmax) and its confidence (the
softmax probability of the argmax class).

Both functions are pure; call ``load_recommender`` once at app startup and
cache the result on ``app.state.recommender_artifacts`` alongside the
existing ``warrant_artifacts``.
"""
from __future__ import annotations

from pathlib import Path
from typing import Mapping, NamedTuple

import numpy as np
import torch

from server.warrant_rules import IntersectionMeta
from server.ml.temporal_warrant import TemporalWarrantCNN


class RecommenderArtifacts(NamedTuple):
    model: TemporalWarrantCNN
    warrant_names: list[str]
    intervention_classes: list[str]
    metadata_features: list[str]


class RecommendationResult(NamedTuple):
    warrant_probs: dict[str, float]
    intervention: str
    intervention_confidence: float


def load_recommender(model_path: Path) -> RecommenderArtifacts:
    """Load the multi-task recommender from a checkpoint. Call once at startup.

    The checkpoint is a dict produced by the training CLI (T12) with the
    architecture hyperparameters from
    ``TemporalWarrantCNN.architecture_config()`` and a ``state_dict`` entry.
    """
    ckpt = torch.load(model_path, map_location="cpu", weights_only=False)

    model = TemporalWarrantCNN(
        n_input_channels=ckpt["n_input_channels"],
        n_slots=ckpt["n_slots"],
        n_metadata_features=ckpt["n_metadata_features"],
        conv_channels=tuple(ckpt["conv_channels"]),
        kernel_size=ckpt["kernel_size"],
        metadata_hidden=ckpt["metadata_hidden"],
        shared_hidden=ckpt["shared_hidden"],
        n_warrants=ckpt["n_warrants"],
        n_intervention_classes=ckpt["n_intervention_classes"],
        dropout=ckpt["dropout"],
        warrant_names=ckpt["warrant_names"],
        intervention_classes=ckpt["intervention_classes"],
        metadata_features=ckpt["metadata_features"],
    )
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    return RecommenderArtifacts(
        model=model,
        warrant_names=list(ckpt["warrant_names"]),
        intervention_classes=list(ckpt["intervention_classes"]),
        metadata_features=list(ckpt["metadata_features"]),
    )


def _metadata_to_vector(
    metadata: IntersectionMeta | Mapping[str, float],
    feature_order: list[str],
) -> np.ndarray:
    """Project intersection metadata into a positional vector.

    Accepts either an ``IntersectionMeta`` dataclass (read by attribute) or a
    plain mapping (read by key) so callers can pass whichever shape is
    convenient - the router (T16) builds an ``IntersectionMeta`` from the
    Intersection row, while tests can pass a dict.
    """
    if isinstance(metadata, IntersectionMeta):
        values = [getattr(metadata, name) for name in feature_order]
    else:
        values = [metadata[name] for name in feature_order]
    return np.array(values, dtype=np.float32)


def predict_recommendations(
    artifacts: RecommenderArtifacts,
    flow_matrix: np.ndarray,
    metadata: IntersectionMeta | Mapping[str, float],
) -> RecommendationResult:
    """Run one forward pass and return warrant probs + intervention class.

    Args:
        artifacts: The loaded recommender (model + label/feature names).
        flow_matrix: ``(n_input_channels, n_slots)`` float array, channels-
            first to match the model's input convention. Same shape as
            ``server.ml.synthetic_traffic.generate_day_flow_matrix`` emits.
        metadata: Intersection metadata, either as ``IntersectionMeta`` or a
            mapping keyed by the feature names persisted on the checkpoint.

    Returns:
        ``RecommendationResult`` with:
            * ``warrant_probs`` - ``{warrant_name: probability ∈ [0, 1]}``
              over the six warrants the model was trained on.
            * ``intervention`` - the argmax intervention class string.
            * ``intervention_confidence`` - the softmax probability of the
              argmax class, in ``[0, 1]``.
    """
    flow_array = np.asarray(flow_matrix, dtype=np.float32)
    flow_tensor = torch.from_numpy(flow_array).unsqueeze(0)

    meta_array = _metadata_to_vector(metadata, artifacts.metadata_features)
    meta_tensor = torch.from_numpy(meta_array).unsqueeze(0)

    with torch.no_grad():
        warrant_logits, intervention_logits = artifacts.model(
            flow_tensor, meta_tensor
        )
        warrant_probs_tensor = torch.sigmoid(warrant_logits).squeeze(0)
        intervention_probs_tensor = torch.softmax(
            intervention_logits, dim=-1
        ).squeeze(0)

    warrant_probs = {
        name: float(prob)
        for name, prob in zip(artifacts.warrant_names, warrant_probs_tensor.tolist())
    }
    intervention_idx = int(torch.argmax(intervention_probs_tensor).item())
    intervention = artifacts.intervention_classes[intervention_idx]
    intervention_confidence = float(intervention_probs_tensor[intervention_idx])

    return RecommendationResult(
        warrant_probs=warrant_probs,
        intervention=intervention,
        intervention_confidence=intervention_confidence,
    )
