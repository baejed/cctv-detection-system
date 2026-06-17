"""Local warrant (W-Local 1/2/3) tests - unit (pure functions) + integration."""
import pytest
from tests.conftest import API_URL


# ── Unit tests ───────────────────────────────────────────────────────────────

def test_w_local_1_triggered_by_high_moto_ratio():
    """W-Local 1 fires when motorcycle+pedicab exceed 60% in any chunk."""
    from server.local_warrants import _compute_w_local_1

    # 80% motorcycle - clearly above default 60% threshold
    counts = [{"motorcycle": 80.0, "car": 20.0}]
    met, conf = _compute_w_local_1(counts, threshold=0.6)
    assert met is True
    assert conf == 1.0  # clamped: min(1.0, 0.8/0.6)


def test_w_local_1_not_triggered_for_low_moto_ratio():
    from server.local_warrants import _compute_w_local_1

    counts = [{"motorcycle": 30.0, "car": 70.0}]  # 30% < 60%
    met, conf = _compute_w_local_1(counts, threshold=0.6)
    assert met is False
    assert conf < 1.0


def test_w_local_1_uses_max_across_chunks():
    """Uses the highest ratio across all chunks, not the first."""
    from server.local_warrants import _compute_w_local_1

    counts = [
        {"motorcycle": 20.0, "car": 80.0},  # 20% - not triggered
        {"motorcycle": 75.0, "car": 25.0},  # 75% - triggered
    ]
    met, _ = _compute_w_local_1(counts, threshold=0.6)
    assert met is True


def test_w_local_1_includes_pedicab_and_tricycle():
    """Pedicab and tricycle count toward the high-risk vehicle ratio."""
    from server.local_warrants import _compute_w_local_1

    # 30% motorcycle + 35% pedicab = 65% total
    counts = [{"motorcycle": 30.0, "pedicab": 35.0, "car": 35.0}]
    met, _ = _compute_w_local_1(counts, threshold=0.6)
    assert met is True


def test_w_local_1_empty_chunks_not_triggered():
    """Zero-count chunks are skipped; result is not-triggered."""
    from server.local_warrants import _compute_w_local_1

    met, conf = _compute_w_local_1([{}, {}], threshold=0.6)
    assert met is False
    assert conf == 0.0


def test_w_local_2_triggered_by_concentrated_volume():
    """W-Local 2 fires when top-2 chunks hold ≥70% of daily volume."""
    from server.local_warrants import _compute_w_local_2

    # AM Peak + PM Peak dominate: 400 + 300 = 700 of 850 total ≈ 82%
    totals = [400.0, 300.0, 50.0, 50.0, 50.0]
    met, conf = _compute_w_local_2(totals, threshold=0.7)
    assert met is True
    assert conf >= 1.0


def test_w_local_2_not_triggered_for_distributed_volume():
    from server.local_warrants import _compute_w_local_2

    # Even spread: top2 = 400/1000 = 40% < 70%
    totals = [200.0, 200.0, 200.0, 200.0, 200.0]
    met, _ = _compute_w_local_2(totals, threshold=0.7)
    assert met is False


def test_w_local_2_empty_returns_false():
    from server.local_warrants import _compute_w_local_2

    met, conf = _compute_w_local_2([0.0, 0.0, 0.0], threshold=0.7)
    assert met is False
    assert conf == 0.0


def test_w_local_3_triggered_by_low_pcu():
    """W-Local 3 fires and returns chunk names for low-PCU chunks."""
    from server.local_warrants import _compute_w_local_3

    pcu_list = [("AM Peak", 50.0), ("Night", 10.0), ("Early Morning", 5.0)]
    met, conf, signal_off = _compute_w_local_3(pcu_list, min_pcu=30.0)
    assert met is True
    assert "Night" in signal_off
    assert "Early Morning" in signal_off
    assert "AM Peak" not in signal_off
    assert conf > 0.0


def test_w_local_3_not_triggered_when_all_above_threshold():
    from server.local_warrants import _compute_w_local_3

    pcu_list = [("AM Peak", 50.0), ("PM Peak", 80.0), ("Midday", 40.0)]
    met, conf, signal_off = _compute_w_local_3(pcu_list, min_pcu=30.0)
    assert met is False
    assert signal_off == []
    assert conf == 0.0


def test_w_local_3_confidence_inversely_proportional_to_pcu_ratio():
    """Deeper below threshold → higher confidence."""
    from server.local_warrants import _compute_w_local_3

    _, conf_very_low, _ = _compute_w_local_3([("X", 1.0)],  min_pcu=30.0)
    _, conf_borderline, _ = _compute_w_local_3([("X", 25.0)], min_pcu=30.0)
    assert conf_very_low > conf_borderline


# ── Integration tests ────────────────────────────────────────────────────────

@pytest.fixture
def intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_wlocal_test_inter", "latitude": 7.4478, "longitude": 125.8057})
    assert r.status_code == 200
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


def test_generate_response_includes_w_local_fields(auth, intersection):
    """generate endpoint includes all six W-Local fields in its response."""
    iid = intersection["id"]
    r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    assert r.status_code == 200
    body = r.json()

    for field in (
        "w_local_1_met", "w_local_1_confidence",
        "w_local_2_met", "w_local_2_confidence",
        "w_local_3_met", "w_local_3_confidence",
    ):
        assert field in body, f"Missing field: {field}"


def test_list_response_includes_w_local_fields(auth, intersection):
    """List endpoint propagates W-Local fields from the stored recommendation."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    recs = auth.get(f"{API_URL}/recommendations/").json()
    this = next((r for r in recs if r["intersection_id"] == iid), None)
    assert this is not None
    assert "w_local_1_met" in this
    assert "w_local_3_met" in this


def test_w_local_3_fires_with_no_traffic_data(auth, intersection):
    """With no aggregation data, W-Local 3 fires (0 PCU < 30 PCU threshold)."""
    iid = intersection["id"]
    r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    assert r.status_code == 200
    body = r.json()

    # No data → 0 PCU/hr per approach, which is below the 30 PCU/hr default
    assert body["w_local_3_met"] is True


def test_timing_rows_include_signal_off_field(auth, intersection):
    """Timing recommendation rows expose the signal_off field."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    rows = auth.get(f"{API_URL}/timing-recommendations/{iid}").json()
    assert len(rows) > 0
    for row in rows:
        assert "signal_off" in row
        assert isinstance(row["signal_off"], bool)


def test_signal_off_set_on_low_pcu_chunks(auth, intersection):
    """All non-overall chunks are signal_off when there is no traffic data."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    rows = auth.get(f"{API_URL}/timing-recommendations/{iid}").json()
    for row in rows:
        if row["chunk_name"] != "overall":
            assert row["signal_off"] is True


def test_local_warrant_config_patch(auth, intersection):
    """PATCH local-warrant-config persists custom thresholds on the intersection."""
    iid = intersection["id"]
    r = auth.patch(
        f"{API_URL}/intersections/{iid}/local-warrant-config",
        json={"w_local_1_threshold": 0.5, "w_local_3_min_pcu": 20.0},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["w_local_1_threshold"] == 0.5
    assert body["w_local_3_min_pcu"] == 20.0
    # Unset field stays at default
    assert body["w_local_2_threshold"] == 0.7
