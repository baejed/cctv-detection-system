"""Tests for the warrant model inference + the /recommendations endpoints."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

from server.ml.inference import load_warrant_model, predict_warrants
from server.routers.recommendations import _compute_features_from_rows

API_URL = os.getenv("API_URL", "http://localhost:8000")


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


# Simple row objects (mimics SQLAlchemy Row) — name, value pairs the function reads.
class _Row:
    def __init__(self, street_id, object_type, window_start, count):
        self.street_id = street_id
        self.object_type = object_type
        self.window_start = window_start
        self.count = count


def _ts(minute: int) -> datetime:
    return datetime(2026, 5, 13, 14, minute, tzinfo=timezone.utc)


def test_feature_extraction_major_minor():
    """Busiest street is major; the rest summed is minor."""
    rows = []
    # Major street (id=1): 800 vehicles spread evenly
    for m in range(60):
        rows.append(_Row(1, "car", _ts(m), 800 // 60 + (1 if m < 800 % 60 else 0)))
    # Minor street A (id=2): 200 vehicles
    for m in range(60):
        rows.append(_Row(2, "car", _ts(m), 200 // 60 + (1 if m < 200 % 60 else 0)))
    # Minor street B (id=3): 100 vehicles
    for m in range(60):
        rows.append(_Row(3, "car", _ts(m), 100 // 60 + (1 if m < 100 % 60 else 0)))

    feats = _compute_features_from_rows(rows)

    assert feats["major_volume"] == 800
    assert feats["minor_volume"] == 300  # 200 + 100


def test_feature_extraction_peds_separated_from_vehicles():
    """Pedestrian object types must not count toward major/minor volumes."""
    rows = [
        _Row(1, "car", _ts(0), 500),
        _Row(1, "pedestrian", _ts(0), 40),
        _Row(2, "person", _ts(0), 60),  # different street, still pedestrian
    ]
    feats = _compute_features_from_rows(rows)
    assert feats["major_volume"] == 500
    assert feats["minor_volume"] == 0
    assert feats["peds"] == 100  # 40 + 60


def test_feature_extraction_vpm_peak_per_minute():
    """vpm is the highest per-minute vehicle count on the major street."""
    rows = [
        # Major street (id=1): 70 total, peak minute is 12
        _Row(1, "car", _ts(0), 5),
        _Row(1, "motorcycle", _ts(0), 3),  # same minute, same street → sum to 8
        _Row(1, "car", _ts(1), 12),
        _Row(1, "car", _ts(2), 7),
        _Row(1, "car", _ts(3), 43),  # extra to keep street 1 as major (70 total)
        # Minor street (id=2): 30 total in one minute; not major, so its 30 doesn't drive vpm
        _Row(2, "car", _ts(0), 30),
    ]
    feats = _compute_features_from_rows(rows)
    assert feats["major_volume"] == 70  # 8 + 12 + 7 + 43
    assert feats["minor_volume"] == 30
    assert feats["vpm"] == 43  # peak per-minute on major street (minute 3)


def test_feature_extraction_phf_uniform_is_one():
    """A perfectly uniform hour has PHF = 1.0."""
    rows = [_Row(1, "car", _ts(m), 10) for m in range(60)]
    feats = _compute_features_from_rows(rows)
    assert feats["major_volume"] == 600
    # 15-min buckets each = 150; peak15 = 150; phf = 600 / (4*150) = 1.0
    assert feats["phf"] == pytest.approx(1.0)


def test_feature_extraction_phf_spike_lower():
    """A spike in one 15-min bucket lowers PHF."""
    rows = []
    # Minutes 0-14: 40/min = 600 in first quarter
    for m in range(15):
        rows.append(_Row(1, "car", _ts(m), 40))
    # Minutes 15-59: 0
    feats = _compute_features_from_rows(rows)
    # major_volume = 600; peak15 = 600; phf = 600 / (4*600) = 0.25
    assert feats["phf"] == pytest.approx(0.25)


def test_feature_extraction_no_data_returns_zeros():
    """Empty rows yields a zero-feature dict and phf defaults to 1.0."""
    feats = _compute_features_from_rows([])
    assert feats == {
        "major_volume": 0,
        "minor_volume": 0,
        "peds": 0,
        "vpm": 0,
        "phf": 1.0,
    }


def test_feature_extraction_phf_single_minute_spike():
    """A single-minute spike yields the natural PHF floor of 0.25."""
    # All 100 vehicles arrive in minute 0 → 15-min bucket 0 = 100; total = 100;
    # phf = 100 / (4 * 100) = 0.25.  This is the mathematical minimum, not a clamp.
    rows = [_Row(1, "car", _ts(0), 100)]
    feats = _compute_features_from_rows(rows)
    assert feats["phf"] == pytest.approx(0.25)


# ─── Integration tests (require docker compose stack + seed data) ────────────


def _first_intersection_id(auth) -> int:
    """Helper — fetch the first intersection from the live API."""
    r = auth.get(f"{API_URL}/intersections/")
    assert r.status_code == 200, r.text
    items = r.json()
    assert items, "No intersections seeded — run scripts/fake_detections.py --seed first"
    return items[0]["id"]


def test_generate_recommendation_endpoint(auth):
    """POST /recommendations/generate/{id} returns the expected schema."""
    iid = _first_intersection_id(auth)
    r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    assert r.status_code == 200, r.text
    body = r.json()

    # Schema check
    expected_keys = {
        "id", "intersection_id", "intersection_name",
        "warrant_1_met", "warrant_1_confidence",
        "warrant_2_met", "warrant_2_confidence",
        "warrant_4_met", "warrant_4_confidence",
        "recommended", "notes", "generated_at",
    }
    assert set(body.keys()) == expected_keys

    # Bool/float types
    for k in ("warrant_1_met", "warrant_2_met", "warrant_4_met", "recommended"):
        assert isinstance(body[k], bool)
    for k in ("warrant_1_confidence", "warrant_2_confidence", "warrant_4_confidence"):
        assert isinstance(body[k], (int, float))
        assert 0.0 <= body[k] <= 1.0

    # Notes is present and references the hour
    assert body["notes"]


def test_generate_all_endpoint(auth):
    """POST /recommendations/generate-all returns one entry per intersection."""
    r = auth.post(f"{API_URL}/recommendations/generate-all")
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body, list)
    assert len(body) >= 1
