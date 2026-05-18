"""PCE configuration layer tests — unit (resolution priority) + integration."""
import pytest
import requests
from unittest.mock import MagicMock, patch
from tests.conftest import API_URL


# ── Unit tests for resolution priority ──────────────────────────────────────

def _make_db(overrides: dict, calibrated: dict):
    """Return a mock Session with the given override/calibrated data."""
    db = MagicMock()

    def query_side_effect(model_cls):
        from common.models import PceOverride, PceCalibratedValue

        mock_q = MagicMock()
        if model_cls is PceOverride:
            rows = [MagicMock(vehicle_type=k, pce_value=v) for k, v in overrides.items()]
        elif model_cls is PceCalibratedValue:
            rows = [MagicMock(vehicle_type=k, pce_value=v) for k, v in calibrated.items()]
        else:
            rows = []
        mock_q.filter_by.return_value.all.return_value = rows
        return mock_q

    db.query.side_effect = query_side_effect
    return db


def test_pce_resolution_override_wins():
    from server.pce import DPWH_DEFAULTS, resolve_pce

    db = _make_db(overrides={"motorcycle": 0.50}, calibrated={"motorcycle": 0.40})
    result = resolve_pce(db, intersection_id=1)

    assert result["motorcycle"]["pce"] == 0.50
    assert result["motorcycle"]["tier"] == "override"


def test_pce_resolution_calibrated_beats_default():
    from server.pce import resolve_pce

    db = _make_db(overrides={}, calibrated={"motorcycle": 0.40})
    result = resolve_pce(db, intersection_id=1)

    assert result["motorcycle"]["pce"] == 0.40
    assert result["motorcycle"]["tier"] == "calibrated"


def test_pce_resolution_default_fallback():
    from server.pce import DPWH_DEFAULTS, resolve_pce

    db = _make_db(overrides={}, calibrated={})
    result = resolve_pce(db, intersection_id=1)

    assert result["motorcycle"]["pce"] == DPWH_DEFAULTS["motorcycle"]
    assert result["motorcycle"]["tier"] == "default"
    assert result["car"]["pce"] == DPWH_DEFAULTS["car"]
    assert result["car"]["tier"] == "default"


def test_pce_all_dpwh_types_present():
    from server.pce import DPWH_DEFAULTS, resolve_pce

    db = _make_db(overrides={}, calibrated={})
    result = resolve_pce(db, intersection_id=1)

    for vtype in DPWH_DEFAULTS:
        assert vtype in result


def test_pce_calibration_clamp():
    """Calibration scale factor must be clamped to ±25% of DPWH default."""
    from server.pce import DPWH_DEFAULTS, calibrate_pce

    db = MagicMock()
    # Simulate very high motorcycle share (90%) to trigger max scale
    db.execute.return_value.fetchall.return_value = [
        MagicMock(object_type="motorcycle", total=900),
        MagicMock(object_type="car",        total=100),
    ]
    db.query.return_value.filter_by.return_value.first.return_value = None

    calibrated = calibrate_pce(db, intersection_id=1)

    # motorcycle observed_share = 0.9, typical = 0.5 → scale = 1.8 → clamped to 1.25
    expected_max = round(DPWH_DEFAULTS["motorcycle"] * 1.25, 4)
    assert calibrated.get("motorcycle") == expected_max


# ── Integration tests ────────────────────────────────────────────────────────

@pytest.fixture
def intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_pce_test", "latitude": 7.4478, "longitude": 125.8057})
    assert r.status_code == 200
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


def test_pce_get_returns_defaults(auth, intersection):
    iid = intersection["id"]
    r = auth.get(f"{API_URL}/intersections/{iid}/pce")
    assert r.status_code == 200
    data = r.json()
    assert data["intersection_id"] == iid
    values = {v["vehicle_type"]: v for v in data["values"]}
    assert values["motorcycle"]["tier"] == "default"
    assert values["car"]["tier"] == "default"
    assert values["motorcycle"]["pce"] == pytest.approx(0.33)


def test_pce_override_takes_precedence(auth, intersection):
    iid = intersection["id"]

    # Set override
    r = auth.post(f"{API_URL}/intersections/{iid}/pce/overrides",
                  json={"vehicle_type": "motorcycle", "pce_value": 0.50})
    assert r.status_code == 200
    values = {v["vehicle_type"]: v for v in r.json()["values"]}
    assert values["motorcycle"]["pce"] == pytest.approx(0.50)
    assert values["motorcycle"]["tier"] == "override"

    # Verify via GET
    r = auth.get(f"{API_URL}/intersections/{iid}/pce")
    values = {v["vehicle_type"]: v for v in r.json()["values"]}
    assert values["motorcycle"]["tier"] == "override"
    assert values["motorcycle"]["pce"] == pytest.approx(0.50)


def test_pce_override_update(auth, intersection):
    iid = intersection["id"]
    auth.post(f"{API_URL}/intersections/{iid}/pce/overrides",
              json={"vehicle_type": "car", "pce_value": 1.20})
    r = auth.post(f"{API_URL}/intersections/{iid}/pce/overrides",
                  json={"vehicle_type": "car", "pce_value": 1.50})
    assert r.status_code == 200
    values = {v["vehicle_type"]: v for v in r.json()["values"]}
    assert values["car"]["pce"] == pytest.approx(1.50)


def test_pce_delete_override_falls_back(auth, intersection):
    iid = intersection["id"]
    auth.post(f"{API_URL}/intersections/{iid}/pce/overrides",
              json={"vehicle_type": "bus", "pce_value": 3.0})
    r = auth.delete(f"{API_URL}/intersections/{iid}/pce/overrides/bus")
    assert r.status_code == 200
    values = {v["vehicle_type"]: v for v in r.json()["values"]}
    assert values["bus"]["tier"] == "default"


def test_pce_override_invalid_value(auth, intersection):
    r = auth.post(f"{API_URL}/intersections/{intersection['id']}/pce/overrides",
                  json={"vehicle_type": "car", "pce_value": -1.0})
    assert r.status_code == 422


def test_pce_404(auth):
    r = auth.get(f"{API_URL}/intersections/999999/pce")
    assert r.status_code == 404
