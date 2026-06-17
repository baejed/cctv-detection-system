"""Webster's formula tests - unit (formula correctness, clamping) + integration."""
import pytest
from sqlalchemy import text
from unittest.mock import MagicMock

from tests.conftest import API_URL


# ── Unit tests ───────────────────────────────────────────────────────────────

def test_compute_timing_basic():
    """Known inputs produce correct cycle length and green splits."""
    from server.webster import compute_timing, SATURATION_FLOW

    # 4 approaches, each with 400 PCU/hr flow (one phase per street, fallback)
    # Y = 4 * (400/S); with S=1400: Y ≈ 1.14 → clamped to max_cycle
    flows = {1: 400.0, 2: 400.0, 3: 400.0, 4: 400.0}
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

    # Y = 4 * (50/S) - stays well below 0.9 for any reasonable S
    flows = {1: 50.0, 2: 50.0, 3: 50.0, 4: 50.0}
    cycle, splits = compute_timing(flows)
    assert 40 <= cycle <= 120
    assert len(splits) == 4


def test_compute_timing_clamped_min():
    """Very low or zero flows clamp to min_cycle (crossing_width_m=0 removes ped_min)."""
    from server.webster import compute_timing

    cycle, splits = compute_timing({1: 0.0, 2: 0.0}, min_cycle=40, crossing_width_m=0)
    assert cycle == 40
    assert len(splits) == 2


def test_compute_timing_clamped_max():
    """Near-saturated flows clamp to max_cycle."""
    from server.webster import compute_timing, SATURATION_FLOW

    # Y ≈ 0.95 → over threshold → max_cycle regardless of S
    flows = {1: round(0.475 * SATURATION_FLOW), 2: round(0.475 * SATURATION_FLOW)}
    cycle, splits = compute_timing(flows, min_cycle=40, max_cycle=120)
    assert cycle == 120


def test_compute_timing_empty_flows():
    """Empty flows return min_cycle and empty splits."""
    from server.webster import compute_timing

    cycle, splits = compute_timing({}, min_cycle=45)
    assert cycle == 45
    assert splits == {}


def test_compute_timing_green_splits_proportional():
    """Approach with double the flow gets double the green time.

    crossing_width_m=0 removes the ped_min clamp so the pure proportional
    split is testable without the floor interfering.
    """
    from server.webster import compute_timing

    flows = {1: 200.0, 2: 100.0}
    cycle, splits = compute_timing(flows, min_cycle=40, max_cycle=120, crossing_width_m=0)
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


def test_warrant_falls_back_to_live_view_when_aggregate_is_stale(auth, db, intersection):
    """Regression: card shows '1230 detected today' from the live SSE stream
    while the warrant badge still says 'No data' - the continuous aggregate
    job had not refreshed yet. _compute_features() should fall back to the
    live detection_street_view when aggregation_summaries is empty for the
    requested hour.
    """
    iid = intersection["id"]

    # Build a minimal arm: street + camera + region.
    sr = auth.post(f"{API_URL}/streets/",
                   json={"intersection_id": iid, "name": "_fb_street",
                         "arm_direction": "northbound"})
    assert sr.status_code == 200
    sid = sr.json()["id"]

    cr = auth.post(f"{API_URL}/cctvs/",
                   json={"intersection_id": iid, "name": "_fb_cam",
                         "rtsp_url": "rtsp://192.168.254.103:1935/cam1"})
    assert cr.status_code == 200
    cid = cr.json()["id"]

    rr = auth.post(f"{API_URL}/regions/",
                   json={"cctv_id": cid, "street_id": sid, "direction": "inbound",
                         "region_points": [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0},
                                           {"x": 1.0, "y": 1.0}, {"x": 0.0, "y": 1.0}]})
    if rr.status_code != 200:
        pytest.skip(f"regions endpoint not available in this env: {rr.status_code} {rr.text}")
    rid = rr.json()["id"]

    try:
        # Insert raw detections in the most-recent-complete-hour window. The
        # continuous-aggregate refresh job won't have caught up to this - so
        # the fallback path is the only way warrant analysis can see them.
        db.execute(text("""
            INSERT INTO detections (cctv_id, object_type, confidence, x1, y1, x2, y2, time)
            SELECT :cid, 'car', 0.9, 0, 0, 100, 100,
                   DATE_TRUNC('hour', NOW() AT TIME ZONE 'UTC') - INTERVAL '30 minutes'
              FROM generate_series(1, 60)
        """), {"cid": cid})
        db.execute(text("""
            INSERT INTO detections_in_regions (region_id, detection_id, time)
            SELECT :rid, d.id, d.time
              FROM detections d
             WHERE d.cctv_id = :cid
        """), {"rid": rid, "cid": cid})
        db.commit()

        # Bypass FastAPI route + use the function directly so this test does
        # not depend on the continuous-aggregate refresh policy.
        from server.routers.recommendations import _compute_features
        features, _ = _compute_features(iid, db)
        assert features["major_volume"] > 0, (
            "live-view fallback should surface raw detections when "
            "aggregation_summaries is stale - got "
            f"major_volume={features['major_volume']}, peds={features['peds']}"
        )

    finally:
        db.execute(text("DELETE FROM detections_in_regions WHERE region_id = :rid"), {"rid": rid})
        db.execute(text("DELETE FROM detections WHERE cctv_id = :cid"), {"cid": cid})
        db.commit()
        auth.delete(f"{API_URL}/regions/{rid}")
        auth.delete(f"{API_URL}/cctvs/{cid}")
        auth.delete(f"{API_URL}/streets/{sid}")


def test_timing_no_data_still_gives_each_approach_green(auth, intersection):
    """Regression: an intersection with streets but no detections must NOT
    return a 40s cycle with empty splits - that renders as 0g/3y/37r per
    approach (a permanently-red signal) in the UI."""
    iid = intersection["id"]

    arms = ["northbound", "southbound", "eastbound", "westbound"]
    street_ids = []
    for arm in arms:
        r = auth.post(f"{API_URL}/streets/",
                      json={"intersection_id": iid,
                            "name": f"_no_data_{arm}",
                            "arm_direction": arm})
        assert r.status_code == 200
        street_ids.append(r.json()["id"])

    try:
        r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
        assert r.status_code == 200

        rows = auth.get(f"{API_URL}/timing-recommendations/{iid}").json()
        assert rows, "expected at least one timing row"

        for row in rows:
            splits = row["green_splits"] or {}
            assert splits, (
                f"chunk {row['chunk_name']!r} has empty green_splits - "
                "every approach would render as 0s green"
            )
            for sid in street_ids:
                g = splits.get(str(sid))
                assert g is not None and g > 0, (
                    f"chunk {row['chunk_name']!r} gives street {sid} "
                    f"green={g} - must be > 0"
                )
    finally:
        for sid in street_ids:
            auth.delete(f"{API_URL}/streets/{sid}")
