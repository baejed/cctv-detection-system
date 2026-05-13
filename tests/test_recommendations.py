"""Tests for the warrant model inference + the /recommendations endpoints."""
from __future__ import annotations

from pathlib import Path

import pytest

from server.ml.inference import load_warrant_model, predict_warrants


@pytest.fixture(scope="module")
def artifacts():
    repo_root = Path(__file__).resolve().parent.parent
    return load_warrant_model(
        repo_root / "server" / "ml" / "warrant_model.pt",
        repo_root / "server" / "ml" / "warrant_scaler.pkl",
    )


def test_predict_warrants_high_volume(artifacts):
    """High major + minor volume should trigger W1 and recommended."""
    probs = predict_warrants(artifacts, {
        "major_volume": 1200,
        "minor_volume": 200,
        "peds": 10,
        "vpm": 25,
        "phf": 0.9,
    })
    assert set(probs.keys()) == {"w1", "w2", "w4", "recommended"}
    assert probs["w1"] >= 0.5, f"w1 was {probs['w1']}"
    assert probs["recommended"] >= 0.5, f"recommended was {probs['recommended']}"


def test_predict_warrants_quiet(artifacts):
    """Low traffic should not trigger any warrant."""
    probs = predict_warrants(artifacts, {
        "major_volume": 100,
        "minor_volume": 20,
        "peds": 5,
        "vpm": 2,
        "phf": 0.7,
    })
    assert probs["recommended"] < 0.5, f"recommended was {probs['recommended']}"


def test_predict_warrants_pedestrian(artifacts):
    """High pedestrian volume with moderate major volume should trigger W4."""
    probs = predict_warrants(artifacts, {
        "major_volume": 700,
        "minor_volume": 50,
        "peds": 150,
        "vpm": 12,
        "phf": 0.85,
    })
    assert probs["w4"] >= 0.5, f"w4 was {probs['w4']}"


def test_predict_warrants_output_shape(artifacts):
    """All probabilities must be in [0, 1] and match the artifact warrants list."""
    probs = predict_warrants(artifacts, {
        "major_volume": 500,
        "minor_volume": 100,
        "peds": 30,
        "vpm": 10,
        "phf": 0.8,
    })
    assert list(probs.keys()) == artifacts.warrants
    for name, p in probs.items():
        assert 0.0 <= p <= 1.0, f"{name} probability out of [0,1]: {p}"
