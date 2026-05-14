"""
Deterministic harness tests for worker heartbeat claiming and CCTV status.

All tests manipulate the worker_heartbeats table directly via SQLAlchemy so
they are not coupled to real worker timing.  The API status field is derived
at query time from last_seen freshness, so we can force every possible state.

CLAIM_EXPIRY_SEC = 15  (from worker/claim.py)
  - last_seen within 15s  → API reports "online"
  - last_seen older than 15s → API reports "offline"
"""
import os
import pytest
from sqlalchemy import text
from tests.conftest import API_URL

CLAIM_EXPIRY_SEC = 15


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_claim_test_inter", "latitude": 7.0, "longitude": 125.0})
    assert r.status_code == 200, r.text
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


@pytest.fixture
def camera(auth, intersection):
    r = auth.post(f"{API_URL}/cctvs/",
                  json={"name": "_claim_test_cam",
                        "rtsp_url": "rtsp://127.0.0.1:8554/claim_test",
                        "intersection_id": intersection["id"]})
    assert r.status_code == 200, r.text
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/cctvs/{obj['id']}")


@pytest.fixture(autouse=True)
def clean_heartbeat(db, camera):
    """Delete any heartbeat row for the test camera before and after each test."""
    cctv_id = camera["id"]
    db.execute(text("DELETE FROM worker_heartbeats WHERE cctv_id = :id"), {"id": cctv_id})
    db.commit()
    yield
    db.execute(text("DELETE FROM worker_heartbeats WHERE cctv_id = :id"), {"id": cctv_id})
    db.commit()


def _insert_heartbeat(db, cctv_id: int, age_seconds: float, version: int = 1) -> None:
    """Insert a heartbeat row with last_seen = NOW() - age_seconds."""
    db.execute(text("""
        INSERT INTO worker_heartbeats
            (cctv_id, worker_pid, last_seen, claimed_at, claim_version, status)
        VALUES
            (:cctv_id, 99999, NOW() - (:age * INTERVAL '1 second'), NOW(), :version, 'running')
        ON CONFLICT (cctv_id) DO UPDATE SET
            worker_pid    = EXCLUDED.worker_pid,
            last_seen     = EXCLUDED.last_seen,
            claimed_at    = EXCLUDED.claimed_at,
            claim_version = EXCLUDED.claim_version,
            status        = EXCLUDED.status
    """), {"cctv_id": cctv_id, "age": age_seconds, "version": version})
    db.commit()


def _api_status(auth, camera_id: int) -> str:
    r = auth.get(f"{API_URL}/cctvs/{camera_id}")
    assert r.status_code == 200, r.text
    return r.json()["status"]


# ---------------------------------------------------------------------------
# Status derivation tests
# ---------------------------------------------------------------------------

def test_new_camera_is_offline(auth, camera):
    """No heartbeat row → status must be offline."""
    assert _api_status(auth, camera["id"]) == "offline"


def test_fresh_heartbeat_shows_online(auth, db, camera):
    """Heartbeat inserted just now (0s old) → online."""
    _insert_heartbeat(db, camera["id"], age_seconds=0)
    assert _api_status(auth, camera["id"]) == "online"


def test_stale_heartbeat_shows_offline(auth, db, camera):
    """Heartbeat 20s old (> CLAIM_EXPIRY_SEC=15) → offline."""
    _insert_heartbeat(db, camera["id"], age_seconds=20)
    assert _api_status(auth, camera["id"]) == "offline"


def test_boundary_within_window_is_online(auth, db, camera):
    """Heartbeat well inside the 15s window (10s old) → online.

    We use 10s rather than 14s: the INSERT-to-API roundtrip takes ~1s on a
    loaded stack, so a 14s margin can flake.  10s gives a 5s buffer while
    still exercising the "within window" branch.
    """
    _insert_heartbeat(db, camera["id"], age_seconds=10)
    assert _api_status(auth, camera["id"]) == "online"


def test_boundary_16s_is_offline(auth, db, camera):
    """16-second-old heartbeat is past the 15s window → offline."""
    _insert_heartbeat(db, camera["id"], age_seconds=16)
    assert _api_status(auth, camera["id"]) == "offline"


def test_list_cameras_reflects_heartbeat_state(auth, db, camera):
    """GET /cctvs/ list status matches GET /cctvs/{id} status."""
    _insert_heartbeat(db, camera["id"], age_seconds=1)

    r = auth.get(f"{API_URL}/cctvs/")
    assert r.status_code == 200
    listing = {c["id"]: c["status"] for c in r.json()}

    assert camera["id"] in listing
    assert listing[camera["id"]] == "online"


# ---------------------------------------------------------------------------
# Claiming logic tests (raw SQL, mirrors worker/claim.py)
# ---------------------------------------------------------------------------

def _can_claim(db, cctv_id: int) -> bool:
    """
    Run the same SELECT the worker uses to find claimable cameras.
    Returns True if this camera appears in the candidate set.
    """
    row = db.execute(text("""
        SELECT id FROM cctvs
        WHERE id = :cctv_id
          AND id NOT IN (
              SELECT cctv_id FROM worker_heartbeats
              WHERE last_seen > NOW() - (:expiry * INTERVAL '1 second')
          )
        FOR UPDATE SKIP LOCKED
    """), {"cctv_id": cctv_id, "expiry": CLAIM_EXPIRY_SEC}).fetchone()
    db.execute(text("ROLLBACK"))
    return row is not None


def test_fresh_heartbeat_blocks_reclaim(db, camera):
    """A camera with a fresh heartbeat must not be claimable."""
    _insert_heartbeat(db, camera["id"], age_seconds=0)
    assert not _can_claim(db, camera["id"])


def test_stale_heartbeat_makes_camera_claimable(db, camera):
    """A camera whose heartbeat expired can be claimed again."""
    _insert_heartbeat(db, camera["id"], age_seconds=20)
    assert _can_claim(db, camera["id"])


def test_no_heartbeat_makes_camera_claimable(db, camera):
    """Camera with no heartbeat row is always claimable."""
    assert _can_claim(db, camera["id"])


def test_claim_version_increments_on_reclaim(db, camera):
    """
    ON CONFLICT DO UPDATE must increment claim_version each time.
    Simulate two successive claims to verify version progression.
    """
    cctv_id = camera["id"]

    db.execute(text("""
        INSERT INTO worker_heartbeats
            (cctv_id, worker_pid, last_seen, claimed_at, claim_version, status)
        VALUES (:cctv_id, 1, NOW(), NOW(), 1, 'running')
        ON CONFLICT (cctv_id) DO UPDATE SET
            claim_version = worker_heartbeats.claim_version + 1,
            last_seen     = NOW()
    """), {"cctv_id": cctv_id})
    db.commit()

    # Second upsert — simulates a reclaim after expiry
    db.execute(text("""
        INSERT INTO worker_heartbeats
            (cctv_id, worker_pid, last_seen, claimed_at, claim_version, status)
        VALUES (:cctv_id, 2, NOW(), NOW(), 1, 'running')
        ON CONFLICT (cctv_id) DO UPDATE SET
            claim_version = worker_heartbeats.claim_version + 1,
            last_seen     = NOW()
    """), {"cctv_id": cctv_id})
    db.commit()

    row = db.execute(
        text("SELECT claim_version FROM worker_heartbeats WHERE cctv_id = :id"),
        {"id": cctv_id}
    ).fetchone()
    assert row is not None
    assert row[0] == 2


# ---------------------------------------------------------------------------
# verify_claim() logic tests
# ---------------------------------------------------------------------------

def test_verify_claim_passes_correct_version(db, camera):
    """verify_claim returns True when expected_version matches stored version."""
    from worker.claim import verify_claim

    _insert_heartbeat(db, camera["id"], age_seconds=0, version=7)
    assert verify_claim(db, camera["id"], expected_version=7) is True


def test_verify_claim_fails_wrong_version(db, camera):
    """verify_claim returns False when versions don't match (claim was stolen)."""
    from worker.claim import verify_claim

    _insert_heartbeat(db, camera["id"], age_seconds=0, version=7)
    assert verify_claim(db, camera["id"], expected_version=6) is False


def test_verify_claim_missing_row_returns_false(db, camera):
    """verify_claim returns False when no heartbeat row exists (released camera)."""
    from worker.claim import verify_claim

    # No heartbeat inserted — row is absent
    assert verify_claim(db, camera["id"], expected_version=1) is False


# ---------------------------------------------------------------------------
# release_camera() tests
# ---------------------------------------------------------------------------

def test_release_removes_heartbeat_and_makes_camera_offline(auth, db, camera):
    """release_camera() deletes the heartbeat; API must report offline immediately."""
    from worker.claim import release_camera

    _insert_heartbeat(db, camera["id"], age_seconds=0)
    assert _api_status(auth, camera["id"]) == "online"

    release_camera(db, camera["id"])

    assert _api_status(auth, camera["id"]) == "offline"

    row = db.execute(
        text("SELECT 1 FROM worker_heartbeats WHERE cctv_id = :id"),
        {"id": camera["id"]}
    ).fetchone()
    assert row is None
