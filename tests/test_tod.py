"""Time-of-day chunk tests - unit (validation + active-chunk lookup) + integration."""
import pytest
from datetime import datetime
from unittest.mock import MagicMock

from tests.conftest import API_URL


# ── Unit tests ───────────────────────────────────────────────────────────────

def test_minutes_to_hhmm():
    from server.tod import minutes_to_hhmm
    assert minutes_to_hhmm(0)    == "00:00"
    assert minutes_to_hhmm(360)  == "06:00"
    assert minutes_to_hhmm(540)  == "09:00"
    assert minutes_to_hhmm(1440) == "24:00"
    assert minutes_to_hhmm(721)  == "12:01"


def test_hhmm_to_minutes():
    from server.tod import hhmm_to_minutes
    assert hhmm_to_minutes("00:00") == 0
    assert hhmm_to_minutes("06:00") == 360
    assert hhmm_to_minutes("24:00") == 1440
    assert hhmm_to_minutes("12:30") == 750


def _make_chunk(name, start, end, iid=1, cid=None):
    c = MagicMock()
    c.id = cid or start
    c.intersection_id = iid
    c.name = name
    c.start_minutes = start
    c.end_minutes = end
    return c


def test_validate_chunks_ok():
    from server.tod import validate_chunks
    chunks = [
        _make_chunk("Early Morning", 0,    360),
        _make_chunk("AM Peak",       360,  540),
        _make_chunk("Midday",        540,  720),
        _make_chunk("PM Peak",       720,  1080),
        _make_chunk("Night",         1080, 1440),
    ]
    validate_chunks(chunks)  # should not raise


def test_validate_chunks_gap():
    from fastapi import HTTPException
    from server.tod import validate_chunks
    chunks = [
        _make_chunk("A", 0,   360),
        _make_chunk("B", 400, 1440),  # gap between 360–400
    ]
    with pytest.raises(HTTPException) as exc:
        validate_chunks(chunks)
    assert exc.value.status_code == 422


def test_validate_chunks_doesnt_start_at_zero():
    from fastapi import HTTPException
    from server.tod import validate_chunks
    chunks = [_make_chunk("A", 60, 1440)]
    with pytest.raises(HTTPException) as exc:
        validate_chunks(chunks)
    assert exc.value.status_code == 422


def test_validate_chunks_doesnt_end_at_1440():
    from fastapi import HTTPException
    from server.tod import validate_chunks
    chunks = [_make_chunk("A", 0, 1380)]
    with pytest.raises(HTTPException) as exc:
        validate_chunks(chunks)
    assert exc.value.status_code == 422


def test_get_active_chunk_pm_peak():
    from server.tod import get_active_chunk, TOD_DEFAULTS

    db = MagicMock()
    chunks = [_make_chunk(name, start, end) for name, start, end in TOD_DEFAULTS]
    db.query.return_value.filter_by.return_value.all.return_value = chunks

    ts = datetime(2026, 5, 18, 14, 0)  # 14:00 → PM Peak (720–1080)
    result = get_active_chunk(db, intersection_id=1, ts=ts)
    assert result.name == "PM Peak"


def test_get_active_chunk_midnight_boundary():
    from server.tod import get_active_chunk, TOD_DEFAULTS

    db = MagicMock()
    chunks = [_make_chunk(name, start, end) for name, start, end in TOD_DEFAULTS]
    db.query.return_value.filter_by.return_value.all.return_value = chunks

    # 00:00 → Early Morning starts at 0 (inclusive)
    ts = datetime(2026, 5, 18, 0, 0)
    result = get_active_chunk(db, intersection_id=1, ts=ts)
    assert result.name == "Early Morning"


# ── Integration tests ────────────────────────────────────────────────────────

@pytest.fixture
def intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_tod_test_inter", "latitude": 7.4478, "longitude": 125.8057})
    assert r.status_code == 200
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


def test_tod_chunks_seeded_on_create(auth, intersection):
    iid = intersection["id"]
    r = auth.get(f"{API_URL}/intersections/{iid}/tod-chunks")
    assert r.status_code == 200
    chunks = r.json()
    assert len(chunks) == 5
    names = {c["name"] for c in chunks}
    assert names == {"Early Morning", "AM Peak", "Midday", "PM Peak", "Night"}


def test_tod_chunks_ordered(auth, intersection):
    iid = intersection["id"]
    chunks = auth.get(f"{API_URL}/intersections/{iid}/tod-chunks").json()
    starts = [c["start_time"] for c in chunks]
    assert starts == ["00:00", "06:00", "09:00", "12:00", "18:00"]


def test_tod_chunk_update_boundary(auth, intersection):
    """Shift AM Peak from 06:00–09:00 to 07:00–09:00 and Early Morning to 00:00–07:00."""
    iid = intersection["id"]
    chunks = auth.get(f"{API_URL}/intersections/{iid}/tod-chunks").json()

    early = next(c for c in chunks if c["name"] == "Early Morning")
    am    = next(c for c in chunks if c["name"] == "AM Peak")

    # First extend Early Morning to 07:00
    r = auth.put(f"{API_URL}/intersections/{iid}/tod-chunks/{early['id']}",
                 json={"name": "Early Morning", "start_time": "00:00", "end_time": "07:00"})
    assert r.status_code == 200

    # Then shift AM Peak start to 07:00
    r = auth.put(f"{API_URL}/intersections/{iid}/tod-chunks/{am['id']}",
                 json={"name": "AM Peak", "start_time": "07:00", "end_time": "09:00"})
    assert r.status_code == 200

    updated = {c["name"]: c for c in r.json()}
    assert updated["Early Morning"]["end_time"] == "07:00"
    assert updated["AM Peak"]["start_time"] == "07:00"


def test_tod_chunk_update_validation_rejects_gap(auth, intersection):
    """A chunk update that would create a gap must be rejected."""
    iid = intersection["id"]
    chunks = auth.get(f"{API_URL}/intersections/{iid}/tod-chunks").json()
    am = next(c for c in chunks if c["name"] == "AM Peak")

    # Shift AM Peak start forward without adjusting Early Morning - creates a gap
    r = auth.put(f"{API_URL}/intersections/{iid}/tod-chunks/{am['id']}",
                 json={"name": "AM Peak", "start_time": "07:00", "end_time": "09:00"})
    assert r.status_code == 422


def test_active_chunk_lookup(auth, intersection):
    """14:30 should fall into PM Peak (12:00–18:00)."""
    iid = intersection["id"]
    r = auth.get(f"{API_URL}/intersections/{iid}/tod-chunks/active",
                 params={"ts": "2026-05-18T14:30:00"})
    assert r.status_code == 200
    assert r.json()["name"] == "PM Peak"


def test_tod_chunks_404(auth):
    r = auth.get(f"{API_URL}/intersections/999999/tod-chunks")
    assert r.status_code == 404
