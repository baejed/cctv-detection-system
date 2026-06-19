"""Inference contract tests for the multi-task TemporalWarrantCNN recommender.

Pure-function tests — no DB, no FastAPI app. Mirrors the style of
`tests/test_warrant_rules.py` and `tests/test_intervention_rules.py`.

Per `docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md`
§Testing Decisions / "Inference contract test":

    `predict_recommendations` returns a `RecommendationResult` with the
    correct field names, warrant_probs dict has all 6 expected keys with
    values in [0, 1], intervention is one of the three valid strings, and
    confidence is in [0, 1]. Tested with a deterministically-initialized
    small model (not the trained one) so the test does not depend on
    training outcomes.

The test exercises external behaviour only — output shapes, value ranges,
field names, and the metadata-input/checkpoint-roundtrip contract — not
internal layer activations, so a future architecture tweak that preserves
the same I/O contract does not break these tests.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import torch

from server.intervention_rules import INTERVENTION_CLASSES
from server.ml.synthetic_traffic import WARRANT_NAMES_ALL
from server.ml.temporal_inference import (
    RecommendationResult,
    RecommenderArtifacts,
    load_recommender,
    predict_recommendations,
)
from server.ml.temporal_warrant import (
    DEFAULT_INTERVENTION_CLASSES,
    DEFAULT_METADATA_FEATURES,
    DEFAULT_WARRANT_NAMES,
    TemporalWarrantCNN,
)
from server.warrant_rules import IntersectionMeta


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def model() -> TemporalWarrantCNN:
    """Deterministically-initialized small model in eval mode.

    Per the PRD: "Tested with a deterministically-initialized small model
    (not the trained one) so the test does not depend on training outcomes."
    Setting a fixed seed before construction makes every nn.Linear / Conv1d
    weight reproducible, which lets later tests compare values bit-for-bit.
    """
    torch.manual_seed(0)
    m = TemporalWarrantCNN()
    m.eval()
    return m


@pytest.fixture(scope="module")
def artifacts(model: TemporalWarrantCNN) -> RecommenderArtifacts:
    """Wrap the model in a RecommenderArtifacts tuple matching its config."""
    return RecommenderArtifacts(
        model=model,
        warrant_names=list(model.warrant_names),
        intervention_classes=list(model.intervention_classes),
        metadata_features=list(model.metadata_features),
    )


@pytest.fixture
def flow_matrix() -> np.ndarray:
    """A deterministic (5, 96) input flow matrix."""
    rng = np.random.default_rng(42)
    return rng.uniform(low=0.0, high=500.0, size=(5, 96)).astype(np.float64)


@pytest.fixture
def meta() -> IntersectionMeta:
    return IntersectionMeta(
        major_lanes=2,
        minor_lanes=1,
        posted_speed_kph=40,
        is_signalized=False,
        n_approaches=4,
    )


# ── RecommendationResult field contract ──────────────────────────────────────

def test_recommendation_result_has_three_fields():
    assert RecommendationResult._fields == (
        "warrant_probs",
        "intervention",
        "intervention_confidence",
    )


def test_predict_returns_recommendation_result_namedtuple(
    artifacts, flow_matrix, meta
):
    result = predict_recommendations(artifacts, flow_matrix, meta)
    assert isinstance(result, RecommendationResult)


# ── warrant_probs contract ───────────────────────────────────────────────────

def test_warrant_probs_has_all_six_expected_keys(artifacts, flow_matrix, meta):
    result = predict_recommendations(artifacts, flow_matrix, meta)
    assert set(result.warrant_probs.keys()) == set(WARRANT_NAMES_ALL)


def test_warrant_probs_keys_match_default_warrant_names_order(
    artifacts, flow_matrix, meta
):
    result = predict_recommendations(artifacts, flow_matrix, meta)
    assert list(result.warrant_probs.keys()) == list(DEFAULT_WARRANT_NAMES)


@pytest.mark.parametrize("warrant_name", list(DEFAULT_WARRANT_NAMES))
def test_each_warrant_prob_is_in_unit_interval(
    artifacts, flow_matrix, meta, warrant_name
):
    result = predict_recommendations(artifacts, flow_matrix, meta)
    prob = result.warrant_probs[warrant_name]
    assert isinstance(prob, float)
    assert 0.0 <= prob <= 1.0


# ── intervention contract ────────────────────────────────────────────────────

def test_intervention_is_one_of_three_valid_strings(
    artifacts, flow_matrix, meta
):
    result = predict_recommendations(artifacts, flow_matrix, meta)
    assert result.intervention in INTERVENTION_CLASSES


def test_intervention_classes_match_module_constants(
    artifacts, flow_matrix, meta
):
    result = predict_recommendations(artifacts, flow_matrix, meta)
    assert result.intervention in DEFAULT_INTERVENTION_CLASSES


def test_intervention_confidence_is_in_unit_interval(
    artifacts, flow_matrix, meta
):
    result = predict_recommendations(artifacts, flow_matrix, meta)
    assert isinstance(result.intervention_confidence, float)
    assert 0.0 <= result.intervention_confidence <= 1.0


def test_intervention_confidence_at_least_one_third(
    artifacts, flow_matrix, meta
):
    """Argmax confidence on a 3-class softmax cannot fall below 1/3."""
    result = predict_recommendations(artifacts, flow_matrix, meta)
    assert result.intervention_confidence >= 1.0 / 3.0 - 1e-6


# ── Metadata input shapes ────────────────────────────────────────────────────

def test_mapping_form_metadata_produces_same_result_as_dataclass(
    artifacts, flow_matrix, meta
):
    """`predict_recommendations` accepts IntersectionMeta or Mapping[str, float]."""
    mapping = {
        "major_lanes": meta.major_lanes,
        "minor_lanes": meta.minor_lanes,
        "posted_speed_kph": meta.posted_speed_kph,
        "is_signalized": meta.is_signalized,
        "n_approaches": meta.n_approaches,
    }
    via_dataclass = predict_recommendations(artifacts, flow_matrix, meta)
    via_mapping = predict_recommendations(artifacts, flow_matrix, mapping)

    assert via_mapping.warrant_probs == via_dataclass.warrant_probs
    assert via_mapping.intervention == via_dataclass.intervention
    assert via_mapping.intervention_confidence == via_dataclass.intervention_confidence


def test_predict_is_deterministic_in_eval_mode(artifacts, flow_matrix, meta):
    """Two calls with the same model + input must agree bitwise (eval mode)."""
    a = predict_recommendations(artifacts, flow_matrix, meta)
    b = predict_recommendations(artifacts, flow_matrix, meta)
    assert a.warrant_probs == b.warrant_probs
    assert a.intervention == b.intervention
    assert a.intervention_confidence == b.intervention_confidence


# ── load_recommender checkpoint roundtrip ────────────────────────────────────

def test_load_recommender_roundtrip_preserves_inference_contract(
    tmp_path: Path, model: TemporalWarrantCNN, flow_matrix, meta
):
    """A saved + reloaded model produces the same RecommendationResult."""
    ckpt = model.architecture_config() | {"state_dict": model.state_dict()}
    ckpt_path = tmp_path / "recommender.pt"
    torch.save(ckpt, ckpt_path)

    loaded = load_recommender(ckpt_path)

    assert isinstance(loaded, RecommenderArtifacts)
    assert loaded.warrant_names == list(DEFAULT_WARRANT_NAMES)
    assert loaded.intervention_classes == list(DEFAULT_INTERVENTION_CLASSES)
    assert loaded.metadata_features == list(DEFAULT_METADATA_FEATURES)

    in_memory_artifacts = RecommenderArtifacts(
        model=model,
        warrant_names=list(model.warrant_names),
        intervention_classes=list(model.intervention_classes),
        metadata_features=list(model.metadata_features),
    )
    a = predict_recommendations(in_memory_artifacts, flow_matrix, meta)
    b = predict_recommendations(loaded, flow_matrix, meta)
    assert a.warrant_probs == b.warrant_probs
    assert a.intervention == b.intervention
    assert a.intervention_confidence == b.intervention_confidence
