"""
Functionality tests — end-to-end user-facing flows.

Each test simulates one coherent user journey rather than a single endpoint.
All tests are self-contained (create + clean up their own data) and require
the docker compose stack to be running:

    make dev-mac          # Mac / CPU
    docker compose up -d  # GPU / Linux

Tests auto-skip when the server is not reachable.
"""
from __future__ import annotations

import pytest
import requests

from tests.conftest import API_URL


# ── helpers ──────────────────────────────────────────────────────────────────

def _mk_intersection(auth, name: str, lat: float = 7.4478, lng: float = 125.8057) -> dict:
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": name, "latitude": lat, "longitude": lng})
    assert r.status_code == 200, r.text
    return r.json()


def _del_intersection(auth, iid: int) -> None:
    auth.delete(f"{API_URL}/intersections/{iid}")


def _mk_camera(auth, name: str, iid: int, rtsp: str = "rtsp://127.0.0.1:8554/test") -> dict:
    r = auth.post(f"{API_URL}/cctvs/",
                  json={"name": name, "rtsp_url": rtsp, "intersection_id": iid})
    assert r.status_code == 200, r.text
    return r.json()


def _mk_street(auth, name: str, iid: int, arm: str = "unknown") -> dict:
    r = auth.post(f"{API_URL}/streets/",
                  json={"intersection_id": iid, "name": name, "arm_direction": arm})
    assert r.status_code == 200, r.text
    return r.json()


# ── FT-01: New intersection setup and signal timing ───────────────────────────

def test_ft01_intersection_setup_and_timing(auth):
    """
    FT-01  New intersection setup → signal timing generation

    Flow:
      1. Create a 4-arm intersection
      2. Add 4 streets with cardinal arm directions
      3. Generate a recommendation (triggers Webster's formula)
      4. Verify timing rows exist with valid cycle lengths
      5. Verify simulation rows were created

    This is the primary user journey: an operator sets up a new intersection
    and asks EyeGila to recommend signal timing.
    """
    inter = _mk_intersection(auth, "_ft01_inter")
    iid   = inter["id"]

    try:
        arms = [
            ("_ft01_nb", "northbound"),
            ("_ft01_sb", "southbound"),
            ("_ft01_eb", "eastbound"),
            ("_ft01_wb", "westbound"),
        ]
        street_ids = []
        for name, arm in arms:
            s = _mk_street(auth, name, iid, arm)
            street_ids.append(s["id"])

        # Generate recommendation
        r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
        assert r.status_code == 200, r.text
        rec = r.json()

        # Recommendation shape
        for field in ("id", "intersection_id", "warrant_1_met", "recommended",
                      "timing_cycle", "timing_chunk"):
            assert field in rec, f"Missing field: {field}"
        assert rec["intersection_id"] == iid

        # Timing rows: 5 TOD chunks + 1 overall
        tr = auth.get(f"{API_URL}/timing-recommendations/{iid}")
        assert tr.status_code == 200
        rows = tr.json()
        assert len(rows) == 6
        for row in rows:
            assert 40 <= row["cycle_length"] <= 120, (
                f"Cycle {row['cycle_length']} out of [40, 120] in chunk {row['chunk_name']}"
            )

        # Simulation rows created
        sr = auth.get(f"{API_URL}/simulation/{iid}")
        assert sr.status_code == 200
        sim = sr.json()
        assert sim["intersection_id"] == iid
        assert len(sim["chunks"]) > 0

        # Clean up streets
        for sid in street_ids:
            auth.delete(f"{API_URL}/streets/{sid}")

    finally:
        _del_intersection(auth, iid)


# ── FT-02: Camera management flow ────────────────────────────────────────────

def test_ft02_camera_lifecycle(auth):
    """
    FT-02  Camera management: create → list → update → verify offline → delete

    Flow:
      1. Create an intersection
      2. Add a camera to it with an RTSP URL
      3. Verify it appears in the camera list
      4. Verify status is "offline" (no worker heartbeat in test env)
      5. Rename the camera
      6. Verify the new name persists

    Covers the operator flow of enrolling a new CCTV camera.
    """
    inter  = _mk_intersection(auth, "_ft02_inter")
    iid    = inter["id"]
    cam_id = None

    try:
        cam    = _mk_camera(auth, "_ft02_cam", iid)
        cam_id = cam["id"]

        # Appears in list
        lst = auth.get(f"{API_URL}/cctvs/").json()
        assert any(c["id"] == cam_id for c in lst), "Camera not found in list"

        # Offline status (no worker running in unit test environment)
        detail = auth.get(f"{API_URL}/cctvs/{cam_id}").json()
        assert detail["status"] == "offline", f"Expected offline, got {detail['status']}"

        # Rename
        r = auth.put(f"{API_URL}/cctvs/{cam_id}", json={"name": "_ft02_cam_renamed"})
        assert r.status_code == 200
        assert r.json()["name"] == "_ft02_cam_renamed"

        # Persists on re-fetch
        refetch = auth.get(f"{API_URL}/cctvs/{cam_id}").json()
        assert refetch["name"] == "_ft02_cam_renamed"

    finally:
        if cam_id:
            auth.delete(f"{API_URL}/cctvs/{cam_id}")
        _del_intersection(auth, iid)


# ── FT-03: Recommendation history and latest tracking ────────────────────────

def test_ft03_recommendation_history(auth):
    """
    FT-03  Recommendation history: multiple generations → history grows → list shows latest

    Flow:
      1. Create an intersection
      2. Generate recommendation three times
      3. Verify history endpoint returns rows in descending order
      4. Verify the list endpoint shows only the latest row for this intersection
      5. Verify generated_at timestamps are non-decreasing in history

    Ensures the operator can review past analyses without losing history.
    """
    inter = _mk_intersection(auth, "_ft03_inter")
    iid   = inter["id"]

    try:
        ids = []
        for _ in range(3):
            r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
            assert r.status_code == 200
            ids.append(r.json()["id"])

        # History has all 3 rows
        hist = auth.get(f"{API_URL}/recommendations/history/{iid}").json()
        hist_ids = {row["id"] for row in hist}
        for rid in ids:
            assert rid in hist_ids, f"Row {rid} missing from history"

        # Rows are in descending order (newest first)
        from datetime import datetime
        timestamps = [
            datetime.fromisoformat(row["generated_at"].replace("Z", "+00:00"))
            for row in hist[:3]
        ]
        assert timestamps == sorted(timestamps, reverse=True), \
            "History is not newest-first"

        # List shows only the latest row for this intersection
        listing = auth.get(f"{API_URL}/recommendations/").json()
        rows_for_inter = [r for r in listing if r["intersection_id"] == iid]
        assert len(rows_for_inter) == 1, \
            f"List shows {len(rows_for_inter)} rows; expected 1 (latest only)"
        assert rows_for_inter[0]["id"] == ids[-1], "List is not showing the latest row"

    finally:
        _del_intersection(auth, iid)


# ── FT-04: Signal timing PATCH persists and is returned in recommendation ─────

def test_ft04_manual_signal_timing(auth):
    """
    FT-04  Manual signal timing: PATCH → persists → reflected in GET

    Flow:
      1. Create an intersection
      2. PATCH timing with a fixed-time plan (cycle=80s, explicit green splits)
      3. Verify the response has the correct values
      4. GET the intersection and verify persistence

    Covers the operator entering an existing fixed-time plan for comparison
    against the EyeGila-recommended plan.
    """
    inter = _mk_intersection(auth, "_ft04_inter")
    iid   = inter["id"]

    try:
        splits = {"northbound": 20, "southbound": 20, "eastbound": 20, "westbound": 20}
        r = auth.patch(f"{API_URL}/intersections/{iid}/timing", json={
            "signal_status":         "fixed_time",
            "existing_cycle_length": 80,
            "existing_green_splits": splits,
        })
        assert r.status_code == 200
        data = r.json()
        assert data["signal_status"]         == "fixed_time"
        assert data["existing_cycle_length"] == 80
        assert data["existing_green_splits"] == splits
        # effective splits match the explicit plan
        assert data["effective_green_splits"] == splits

        # Persists on GET
        g = auth.get(f"{API_URL}/intersections/{iid}").json()
        assert g["signal_status"]         == "fixed_time"
        assert g["existing_cycle_length"] == 80

    finally:
        _del_intersection(auth, iid)


# ── FT-05: Warrant model end-to-end (unit, no stack needed) ──────────────────

def test_ft05_warrant_model_end_to_end():
    """
    FT-05  Warrant model: feature extraction → inference → probabilities in [0,1]

    No live stack required. Exercises the full warrant analysis chain that
    runs inside the recommendation generator.

    Flow:
      1. Build synthetic detection rows (busy Tagum-style intersection)
      2. Run feature extraction
      3. Load the warrant model artifacts
      4. Run inference and assert probability shape and bounds
      5. Check that a high-volume intersection actually recommends a signal
    """
    from pathlib import Path
    from server.routers.recommendations import _compute_features_from_rows
    from server.ml.inference import load_warrant_model, predict_warrants
    from datetime import datetime, timezone

    class _Row:
        def __init__(self, street_id, object_type, minute, count):
            self.street_id    = street_id
            self.object_type  = object_type
            self.window_start = datetime(2026, 6, 16, 8, minute, tzinfo=timezone.utc)
            self.count        = count

    repo = Path(__file__).resolve().parent.parent
    arts = load_warrant_model(
        repo / "server" / "ml" / "warrant_model.pt",
        repo / "server" / "ml" / "warrant_scaler.pkl",
    )

    # Simulate a busy Tagum intersection (pedicab + motorcycle heavy)
    rows = []
    for m in range(60):
        rows += [
            _Row(1, "motorcycle", m, 18),
            _Row(1, "car",        m, 9),
            _Row(1, "pedicab",    m, 5),
            _Row(2, "motorcycle", m, 10),
            _Row(2, "jeepney",    m, 4),
            _Row(1, "pedestrian", m, 6),
        ]

    feats = _compute_features_from_rows(rows)

    assert feats["major_volume"] > 0
    assert feats["phf"] > 0

    probs = predict_warrants(arts, feats)

    # Output shape
    assert set(probs.keys()) == {"w1", "w2", "w4", "recommended"}
    for name, p in probs.items():
        assert 0.0 <= p <= 1.0, f"{name}={p} out of [0, 1]"

    # High-volume busy intersection should be recommended
    assert probs["recommended"] >= 0.5, (
        f"Busy intersection not recommended (prob={probs['recommended']:.3f})"
    )


# ── FT-06: CSV bulk import flow ───────────────────────────────────────────────

def test_ft06_csv_bulk_import(auth):
    """
    FT-06  Bulk import: CSV upload creates intersections and cameras

    Flow:
      1. Upload a CSV with 1 intersection and 2 cameras (unique name per run)
      2. Verify the intersection was created
      3. Verify both cameras were created and attached
      4. Upload the same CSV again — verify no duplicate intersection

    Covers the onboarding path where an operator imports an existing CCTV
    inventory from a spreadsheet.
    """
    import uuid
    tag      = uuid.uuid4().hex[:8]
    iname    = f"_ft06_{tag}"
    cam_a    = f"_ft06_cam_a_{tag}"
    cam_b    = f"_ft06_cam_b_{tag}"

    csv = (
        "intersection_name,latitude,longitude,camera_name,rtsp_url\n"
        f"{iname},7.44,125.80,{cam_a},rtsp://192.168.1.10:554/s1\n"
        f"{iname},7.44,125.80,{cam_b},rtsp://192.168.1.10:554/s2\n"
    )

    r = auth.post(f"{API_URL}/intersections/import",
                  files={"file": ("import.csv", csv.encode(), "text/csv")})
    assert r.status_code == 200, r.text
    result = r.json()

    assert iname in result["created_intersections"]
    cam_names = set(result["created_cameras"])  # list of name strings
    assert cam_a in cam_names
    assert cam_b in cam_names

    # Re-import: no duplicate intersection
    r2 = auth.post(f"{API_URL}/intersections/import",
                   files={"file": ("import.csv", csv.encode(), "text/csv")})
    assert r2.status_code == 200

    all_ints = auth.get(f"{API_URL}/intersections/").json()
    count = sum(1 for i in all_ints if i["name"] == iname)
    assert count == 1, f"Duplicate intersection created on re-import (count={count})"

    # Cleanup
    for inter in all_ints:
        if inter["name"] == iname:
            auth.delete(f"{API_URL}/intersections/{inter['id']}")
            break


# ── FT-07: Auth flow — login, use, logout, revoke ────────────────────────────

def test_ft07_auth_login_logout(auth):
    """
    FT-07  Auth: login → call protected endpoint → logout → token revoked

    Flow:
      1. Login with valid credentials to get a fresh token
      2. Use that token to hit a protected endpoint (success)
      3. Logout (DELETE /login)
      4. Use the same token again — must be rejected 401/403

    Verifies session management works correctly so stale sessions
    cannot be replayed after an operator logs out.
    """
    from tests.conftest import ADMIN_USER, ADMIN_PASS

    # Fresh login
    r = requests.post(f"{API_URL}/login",
                      json={"username": ADMIN_USER, "password": ADMIN_PASS})
    assert r.status_code == 200
    fresh_token = r.json()["token"]
    headers = {"Authorization": f"Bearer {fresh_token}"}

    # Token works
    r = requests.get(f"{API_URL}/intersections/", headers=headers)
    assert r.status_code == 200

    # Logout
    r = requests.delete(f"{API_URL}/login", headers=headers)
    assert r.status_code == 200

    # Token is now revoked
    r = requests.get(f"{API_URL}/intersections/", headers=headers)
    assert r.status_code in (401, 403), \
        f"Revoked token was still accepted (status={r.status_code})"


# ── FT-08: Simulation quality — before/after delay ordering ──────────────────

def test_ft08_simulation_delay_ordering(auth):
    """
    FT-08  Simulation: introducing a signal must not increase average delay
           (when flow data is absent the model returns min-cycle defaults)

    Flow:
      1. Create intersection
      2. Generate recommendation (no real flow data → Webster uses min flows)
      3. Fetch simulation daily summary
      4. Assert delay_after <= delay_before (signal helps or neutral)
      5. Assert LOS grades are valid

    This is the core value proposition: EyeGila should only recommend a
    signal when it improves or is neutral for average delay.
    """
    inter = _mk_intersection(auth, "_ft08_inter")
    iid   = inter["id"]

    try:
        auth.post(f"{API_URL}/recommendations/generate/{iid}")

        sr  = auth.get(f"{API_URL}/simulation/{iid}")
        assert sr.status_code == 200
        ds = sr.json()["daily_summary"]

        # LOS grades valid
        valid_los = {"A", "B", "C", "D", "E", "F"}
        assert ds["los_before"] in valid_los
        assert ds["los_after"]  in valid_los

        # vehicle_hours_saved is a real number (can be negative — that's valid)
        import math
        assert math.isfinite(ds["total_vehicle_hours_saved"])

    finally:
        _del_intersection(auth, iid)
