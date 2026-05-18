"""Webster's formula tests — unit (formula correctness, clamping) + integration."""
import pytest
from unittest.mock import MagicMock

from tests.conftest import API_URL


# ── Unit tests ───────────────────────────────────────────────────────────────

def test_compute_timing_basic():
    """Known inputs produce correct cycle length and green splits."""
    from server.webster import compute_timing, SATURATION_FLOW

    # 4 approaches, each with 400 PCU/hr flow
    flows = {1: 400.0, 2: 400.0, 3: 400.0, 4: 400.0}
    # Y = 4 * (400/1800) ≈ 0.889
    # L = 4 * (4 + 3) = 28
    # C_opt = (1.5*28 + 5) / (1 - 0.889) ≈ 47 / 0.111 ≈ 423  → clamped to 120
    cycle, splits = compute_timing(flows, lost_time_per_phase=4, all_red_clearance=3,
                                   min_cycle=40, max_cycle=120)
    assert cycle == 120
    assert len(splits) == 4
    # Each split should be equal (symmetric flows)
    split_values = list(splits.values())
    assert abs(split_values[0] - split_values[1]) < 1.0


def test_compute_timing_low_flow():
    """Low flows produce a cycle near the minimum."""
    from server.webster import compute_timing

    flows = {1: 50.0, 2: 50.0, 3: 50.0, 4: 50.0}
    # Y = 4 * (50/1800) ≈ 0.111
    # C_opt = (1.5*28 + 5) / (1 - 0.111) ≈ 47 / 0.889 ≈ 52.9 → rounds to 53
    cycle, splits = compute_timing(flows)
    assert 40 <= cycle <= 120
    assert len(splits) == 4


def test_compute_timing_clamped_min():
    """Very low or zero flows clamp to min_cycle."""
    from server.webster import compute_timing

    cycle, splits = compute_timing({1: 0.0, 2: 0.0}, min_cycle=40)
    assert cycle == 40
    assert len(splits) == 2


def test_compute_timing_clamped_max():
    """Near-saturated flows clamp to max_cycle."""
    from server.webster import compute_timing

    # Y ≈ 0.95 → over threshold → max
    flows = {1: 855.0, 2: 855.0}   # 2 * (855/1800) = 0.95
    cycle, splits = compute_timing(flows, min_cycle=40, max_cycle=120)
    assert cycle == 120


def test_compute_timing_empty_flows():
    """Empty flows return min_cycle and empty splits."""
    from server.webster import compute_timing

    cycle, splits = compute_timing({}, min_cycle=45)
    assert cycle == 45
    assert splits == {}


def test_compute_timing_green_splits_proportional():
    """Approach with double the flow gets double the green time."""
    from server.webster import compute_timing

    flows = {1: 200.0, 2: 100.0}
    cycle, splits = compute_timing(flows, min_cycle=40, max_cycle=120)
    assert cycle >= 40
    # Approach 1 should get roughly twice the green of approach 2
    ratio = splits[1] / splits[2]
    assert abs(ratio - 2.0) < 0.2


def test_compute_timing_custom_bounds():
    """Custom min/max cycle bounds are respected."""
    from server.webster import compute_timing

    flows = {1: 100.0, 2: 100.0}
    cycle, _ = compute_timing(flows, min_cycle=60, max_cycle=90)
    assert 60 <= cycle <= 90


def test_dominant_pce_tier_priority():
    """Override tier takes priority over calibrated and default."""
    from server.webster import _dominant_pce_tier

    pce_map = {
        "car":        {"pce": 1.0,  "tier": "default"},
        "motorcycle": {"pce": 0.33, "tier": "calibrated"},
        "bus":        {"pce": 2.5,  "tier": "override"},
    }
    assert _dominant_pce_tier(pce_map) == "override"


def test_dominant_pce_tier_calibrated():
    from server.webster import _dominant_pce_tier

    pce_map = {
        "car":        {"pce": 1.0,  "tier": "default"},
        "motorcycle": {"pce": 0.35, "tier": "calibrated"},
    }
    assert _dominant_pce_tier(pce_map) == "calibrated"


def test_dominant_pce_tier_default():
    from server.webster import _dominant_pce_tier

    pce_map = {"car": {"pce": 1.0, "tier": "default"}}
    assert _dominant_pce_tier(pce_map) == "default"


# ── Integration tests ────────────────────────────────────────────────────────

@pytest.fixture
def intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_timing_test_inter", "latitude": 7.4478, "longitude": 125.8057})
    assert r.status_code == 200
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


def test_generate_inserts_timing_rows(auth, intersection):
    """generate recommendation → timing_recommendations rows created (chunks + overall)."""
    iid = intersection["id"]

    r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    assert r.status_code == 200

    tr = auth.get(f"{API_URL}/timing-recommendations/{iid}")
    assert tr.status_code == 200
    rows = tr.json()

    chunk_names = {row["chunk_name"] for row in rows}
    assert "overall" in chunk_names
    # 5 default TOD chunks + 1 overall
    assert len(rows) == 6


def test_timing_rows_have_valid_cycle_length(auth, intersection):
    """All timing rows have cycle lengths within bounds."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    rows = auth.get(f"{API_URL}/timing-recommendations/{iid}").json()
    for row in rows:
        assert 40 <= row["cycle_length"] <= 120


def test_recommendation_response_includes_timing(auth, intersection):
    """generate endpoint returns timing_cycle and timing_chunk fields."""
    iid = intersection["id"]
    r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    body = r.json()

    # timing_cycle may be None (no data) but field must be present
    assert "timing_cycle" in body
    assert "timing_chunk" in body


def test_list_recommendations_includes_timing(auth, intersection):
    """List endpoint returns timing_cycle / timing_chunk per recommendation."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    recs = auth.get(f"{API_URL}/recommendations/").json()
    this = next((r for r in recs if r["intersection_id"] == iid), None)
    assert this is not None
    assert "timing_cycle" in this
    assert "timing_chunk" in this


def test_timing_endpoint_404(auth):
    """Returns 404 for nonexistent intersection."""
    r = auth.get(f"{API_URL}/timing-recommendations/999999")
    assert r.status_code == 404


def test_generate_all_inserts_timing_rows(auth, intersection):
    """generate-all endpoint creates timing rows for all intersections."""
    r = auth.post(f"{API_URL}/recommendations/generate-all")
    assert r.status_code == 200
    results = r.json()
    for rec in results:
        assert "timing_cycle" in rec
