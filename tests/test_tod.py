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


def test_tod_defaults_tile_the_full_day_without_gaps():
    """TOD_DEFAULTS must cover [0, 1440) contiguously and monotonically.

    Catches the class of bug where editing TOD_DEFAULTS leaves a gap, an
    overlap, or a chunk that doesn't reach midnight - any of which would
    silently break Webster's per-chunk timing and the active-chunk lookup.
    """
    from server.tod import TOD_DEFAULTS

    assert len(TOD_DEFAULTS) == 5
    assert TOD_DEFAULTS[0][1] == 0,    "first chunk must start at 00:00"
    assert TOD_DEFAULTS[-1][2] == 1440, "last chunk must end at 24:00"
    for name, start, end in TOD_DEFAULTS:
        assert start < end, f"chunk {name!r} has zero/negative span"
    for prev, nxt in zip(TOD_DEFAULTS, TOD_DEFAULTS[1:]):
        assert prev[2] == nxt[1], f"gap or overlap between {prev[0]!r} and {nxt[0]!r}"


def test_tod_defaults_use_rush_hour_vocabulary():
    """Default chunk names must reflect the rush-hour vocabulary the CNN was trained on.

    The synthetic dataset uses AM_RUSH/MIDDAY/PM_RUSH/OFF_PEAK regimes; surfacing
    the legacy 'AM Peak'/'PM Peak' labels in production would mislead operators
    into thinking they were looking at a different model's regimes.
    """
    from server.tod import TOD_DEFAULTS
    names = {name for name, _, _ in TOD_DEFAULTS}
    assert names == {"Overnight", "AM Rush", "Midday", "PM Rush", "Evening"}
    # Legacy names must not reappear by accident
    legacy = {"AM Peak", "PM Peak", "Early Morning", "Night"}
    assert names.isdisjoint(legacy)


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
        _make_chunk("Overnight", 0,    360),
        _make_chunk("AM Rush",   360,  540),
        _make_chunk("Midday",    540,  720),
        _make_chunk("PM Rush",   720,  1080),
        _make_chunk("Evening",   1080, 1440),
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

    ts = datetime(2026, 5, 18, 14, 0)  # 14:00 → PM Rush (720–1080)
    result = get_active_chunk(db, intersection_id=1, ts=ts)
    assert result.name == "PM Rush"


def test_get_active_chunk_midnight_boundary():
    from server.tod import get_active_chunk, TOD_DEFAULTS

    db = MagicMock()
    chunks = [_make_chunk(name, start, end) for name, start, end in TOD_DEFAULTS]
    db.query.return_value.filter_by.return_value.all.return_value = chunks

    # 00:00 → Overnight starts at 0 (inclusive)
    ts = datetime(2026, 5, 18, 0, 0)
    result = get_active_chunk(db, intersection_id=1, ts=ts)
    assert result.name == "Overnight"


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
    assert names == {"Overnight", "AM Rush", "Midday", "PM Rush", "Evening"}


def test_tod_chunks_ordered(auth, intersection):
    iid = intersection["id"]
    chunks = auth.get(f"{API_URL}/intersections/{iid}/tod-chunks").json()
    starts = [c["start_time"] for c in chunks]
    assert starts == ["00:00", "06:00", "09:00", "12:00", "18:00"]


def test_tod_chunk_update_boundary(auth, intersection):
    """Shift AM Rush from 06:00–09:00 to 07:00–09:00 and Overnight to 00:00–07:00."""
    iid = intersection["id"]
    chunks = auth.get(f"{API_URL}/intersections/{iid}/tod-chunks").json()

    early = next(c for c in chunks if c["name"] == "Overnight")
    am    = next(c for c in chunks if c["name"] == "AM Rush")

    # First extend Overnight to 07:00
    r = auth.put(f"{API_URL}/intersections/{iid}/tod-chunks/{early['id']}",
                 json={"name": "Overnight", "start_time": "00:00", "end_time": "07:00"})
    assert r.status_code == 200

    # Then shift AM Rush start to 07:00
    r = auth.put(f"{API_URL}/intersections/{iid}/tod-chunks/{am['id']}",
                 json={"name": "AM Rush", "start_time": "07:00", "end_time": "09:00"})
    assert r.status_code == 200

    updated = {c["name"]: c for c in r.json()}
    assert updated["Overnight"]["end_time"] == "07:00"
    assert updated["AM Rush"]["start_time"] == "07:00"


def test_tod_chunk_update_validation_rejects_gap(auth, intersection):
    """A chunk update that would create a gap must be rejected."""
    iid = intersection["id"]
    chunks = auth.get(f"{API_URL}/intersections/{iid}/tod-chunks").json()
    am = next(c for c in chunks if c["name"] == "AM Rush")

    # Shift AM Rush start forward without adjusting Overnight - creates a gap
    r = auth.put(f"{API_URL}/intersections/{iid}/tod-chunks/{am['id']}",
                 json={"name": "AM Rush", "start_time": "07:00", "end_time": "09:00"})
    assert r.status_code == 422


def test_active_chunk_lookup(auth, intersection):
    """14:30 should fall into PM Rush (12:00–18:00)."""
    iid = intersection["id"]
    r = auth.get(f"{API_URL}/intersections/{iid}/tod-chunks/active",
                 params={"ts": "2026-05-18T14:30:00"})
    assert r.status_code == 200
    assert r.json()["name"] == "PM Rush"


def test_tod_chunks_404(auth):
    r = auth.get(f"{API_URL}/intersections/999999/tod-chunks")
    assert r.status_code == 404
