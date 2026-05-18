"""Analytical delay simulation tests — unit (delay formulas) + integration."""
import math
import pytest

from tests.conftest import API_URL


# ── Unit tests ───────────────────────────────────────────────────────────────

def test_uniform_delay_typical():
    """Webster's uniform delay produces a plausible value for a typical input."""
    from server.simulation import compute_uniform_delay

    # C=90s, g=30s, q=400 PCU/hr  →  lam=0.333, x=400*90/(1800*30)=0.667
    # d = 90*(1-0.333)^2 / (2*(1-0.667)) = 90*0.444 / 0.666 ≈ 60s
    d = compute_uniform_delay(C=90, g=30, q_pcu_hr=400)
    assert 30 < d < 120


def test_uniform_delay_zero_flow():
    from server.simulation import compute_uniform_delay
    assert compute_uniform_delay(C=90, g=30, q_pcu_hr=0) == 0.0


def test_uniform_delay_zero_green():
    from server.simulation import compute_uniform_delay
    assert compute_uniform_delay(C=90, g=0, q_pcu_hr=400) == 0.0


def test_uniform_delay_near_saturation():
    """Near-saturated demand should be capped, not infinite."""
    from server.simulation import compute_uniform_delay
    d = compute_uniform_delay(C=90, g=30, q_pcu_hr=1700)
    assert math.isfinite(d)
    assert d > 0


def test_uniform_delay_longer_green_reduces_delay():
    """More green time → less delay (all else equal)."""
    from server.simulation import compute_uniform_delay
    d_short = compute_uniform_delay(C=90, g=20, q_pcu_hr=300)
    d_long  = compute_uniform_delay(C=90, g=50, q_pcu_hr=300)
    assert d_short > d_long


def test_hcm_gap_delay_no_major():
    """Zero major-street flow → minimal delay."""
    from server.simulation import compute_hcm_gap_delay
    d = compute_hcm_gap_delay(q_major_pcu_hr=0, q_minor_pcu_hr=100)
    assert d == 5.0


def test_hcm_gap_delay_heavy_major():
    """Heavy major-street flow → more delay than zero-major case."""
    from server.simulation import compute_hcm_gap_delay
    d_heavy = compute_hcm_gap_delay(q_major_pcu_hr=800, q_minor_pcu_hr=100)
    d_none  = compute_hcm_gap_delay(q_major_pcu_hr=0,   q_minor_pcu_hr=100)
    assert d_heavy > d_none


def test_hcm_gap_delay_finite():
    """Should never return infinity."""
    from server.simulation import compute_hcm_gap_delay
    d = compute_hcm_gap_delay(q_major_pcu_hr=1200, q_minor_pcu_hr=200)
    assert math.isfinite(d)


def test_queue_series_signalized_length():
    """Queue series has exactly 60 values (one per minute)."""
    from server.simulation import _queue_series_signalized
    series = _queue_series_signalized(q_pcu_hr=400, C=90, g=30)
    assert len(series) == 60


def test_queue_series_signalized_nonnegative():
    from server.simulation import _queue_series_signalized
    series = _queue_series_signalized(q_pcu_hr=300, C=60, g=25)
    assert all(v >= 0 for v in series)


def test_queue_series_unsignalized_stable():
    """When capacity > arrival the queue stays at 0."""
    from server.simulation import _queue_series_unsignalized
    series = _queue_series_unsignalized(q_pcu_hr=100, capacity_pcu_hr=600)
    assert all(v == 0.0 for v in series)


# ── Integration tests ────────────────────────────────────────────────────────

@pytest.fixture
def intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_sim_test_inter", "latitude": 7.4478, "longitude": 125.8057})
    assert r.status_code == 200
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


def test_generate_creates_simulation_rows(auth, intersection):
    """Generating a recommendation triggers simulation row creation, fetchable via GET."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    r = auth.get(f"{API_URL}/simulation/{iid}")
    assert r.status_code == 200
    body = r.json()
    assert body["intersection_id"] == iid
    assert "chunks" in body
    assert "daily_summary" in body


def test_simulation_chunk_fields(auth, intersection):
    """Each simulation chunk has the required numeric fields."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    body = auth.get(f"{API_URL}/simulation/{iid}").json()
    for chunk in body["chunks"]:
        assert "delay_before" in chunk
        assert "delay_after"  in chunk
        assert chunk["delay_before"] >= 0
        assert chunk["delay_after"]  >= 0


def test_simulation_queue_series_present(auth, intersection):
    """Queue series JSON is present (may be null when no flow data exists)."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    body = auth.get(f"{API_URL}/simulation/{iid}").json()
    # fields must exist in each chunk (value may be null when no flow data)
    for chunk in body["chunks"]:
        assert "queue_series_before" in chunk
        assert "queue_series_after"  in chunk


def test_simulation_daily_summary(auth, intersection):
    """daily_summary has the four required fields."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate/{iid}")

    body = auth.get(f"{API_URL}/simulation/{iid}").json()
    ds = body["daily_summary"]
    assert "total_vehicle_hours_saved" in ds
    assert "avg_delay_before"          in ds
    assert "avg_delay_after"           in ds
    assert "total_volume_pcu_hr"       in ds


def test_simulation_404_no_recommendation(auth):
    """Returns 404 when intersection has no recommendations."""
    r = auth.get(f"{API_URL}/simulation/999999")
    assert r.status_code == 404


def test_generate_all_creates_simulation_rows(auth, intersection):
    """generate-all endpoint also produces simulation rows."""
    iid = intersection["id"]
    auth.post(f"{API_URL}/recommendations/generate-all")

    r = auth.get(f"{API_URL}/simulation/{iid}")
    assert r.status_code == 200
