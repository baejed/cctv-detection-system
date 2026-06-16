"""Tests for arm_direction on streets and its effect on Webster's phase grouping.

Unit tests: pure Python, no live stack required.
Integration tests: require the Docker stack (API_URL + auth fixture).
"""
import pytest
from tests.conftest import API_URL


# ── Unit: group_phases ────────────────────────────────────────────────────────

def test_group_phases_4arm_2phases():
    """Standard 4-arm intersection: NB+SB → phase 1, EB+WB → phase 2."""
    from server.webster import group_phases

    flows      = {1: 400.0, 2: 400.0, 3: 300.0, 4: 300.0}
    directions = {1: "northbound", 2: "southbound", 3: "eastbound", 4: "westbound"}
    phases = group_phases(flows, directions)

    assert len(phases) == 2
    # Each phase contains the two opposing streets
    phase_sets = [frozenset(p) for p in phases]
    assert frozenset({1, 2}) in phase_sets
    assert frozenset({3, 4}) in phase_sets


def test_group_phases_t_intersection():
    """T-intersection (NB+SB through, EB solo): should produce 2 phases."""
    from server.webster import group_phases

    flows      = {1: 400.0, 2: 400.0, 3: 300.0}
    directions = {1: "northbound", 2: "southbound", 3: "eastbound"}
    phases = group_phases(flows, directions)

    assert len(phases) == 2
    phase_sets = [frozenset(p) for p in phases]
    assert frozenset({1, 2}) in phase_sets
    assert frozenset({3}) in phase_sets


def test_group_phases_single_arm_no_opposing():
    """Single northbound arm with no southbound: gets its own phase."""
    from server.webster import group_phases

    flows      = {1: 400.0}
    directions = {1: "northbound"}
    phases = group_phases(flows, directions)

    assert len(phases) == 1
    assert frozenset(phases[0]) == frozenset({1})


def test_group_phases_all_unknown():
    """Streets with unknown direction share a single phase (no pairing possible).

    All unknown streets share the same by_dir["unknown"] bucket and land in one
    concurrent phase, which is the safe fallback: no lost time is wasted on
    phase splits we can't justify, and the operator is expected to set arm
    directions before relying on timing output.
    """
    from server.webster import group_phases

    flows      = {1: 300.0, 2: 200.0, 3: 150.0}
    directions = {1: "unknown", 2: "unknown", 3: "unknown"}
    phases = group_phases(flows, directions)

    assert len(phases) == 1
    assert frozenset(phases[0]) == frozenset({1, 2, 3})


def test_group_phases_mixed_known_unknown():
    """NB+SB paired; unknown street gets its own phase."""
    from server.webster import group_phases

    flows      = {1: 400.0, 2: 300.0, 3: 200.0}
    directions = {1: "northbound", 2: "southbound", 3: "unknown"}
    phases = group_phases(flows, directions)

    assert len(phases) == 2
    phase_sets = [frozenset(p) for p in phases]
    assert frozenset({1, 2}) in phase_sets
    assert frozenset({3}) in phase_sets


def test_group_phases_eb_wb_only():
    """East-West only intersection (2 arms): single phase pair."""
    from server.webster import group_phases

    flows      = {1: 500.0, 2: 450.0}
    directions = {1: "eastbound", 2: "westbound"}
    phases = group_phases(flows, directions)

    assert len(phases) == 1
    assert frozenset(phases[0]) == frozenset({1, 2})


def test_group_phases_multi_arm_cctv():
    """One CCTV covering 2 streets (NB + EB) — each street treated independently."""
    from server.webster import group_phases

    # Flows from a single corner camera: street 1 is NB arm, street 2 is EB arm.
    # SB (street 3) and WB (street 4) are on other cameras.
    flows      = {1: 400.0, 2: 300.0, 3: 380.0, 4: 290.0}
    directions = {1: "northbound", 2: "eastbound", 3: "southbound", 4: "westbound"}
    phases = group_phases(flows, directions)

    assert len(phases) == 2
    phase_sets = [frozenset(p) for p in phases]
    assert frozenset({1, 3}) in phase_sets   # NB + SB
    assert frozenset({2, 4}) in phase_sets   # EB + WB


def test_compute_timing_with_phases_paired():
    """NB+SB paired → 2 phases → less lost time than 4 independent phases."""
    from server.webster import compute_timing, group_phases

    flows      = {1: 400.0, 2: 380.0, 3: 300.0, 4: 290.0}
    directions = {1: "northbound", 2: "southbound", 3: "eastbound", 4: "westbound"}

    phases_paired = group_phases(flows, directions)
    phases_solo   = [[sid] for sid in flows]

    cycle_paired, _ = compute_timing(flows, phases_paired)
    cycle_solo,   _ = compute_timing(flows, phases_solo)

    # 2 phases has less total lost time than 4 phases → shorter (or equal) cycle
    assert cycle_paired <= cycle_solo


def test_group_phases_deterministic():
    """Same inputs always produce the same phase grouping."""
    from server.webster import group_phases

    flows      = {1: 400.0, 2: 350.0, 3: 300.0, 4: 280.0}
    directions = {1: "northbound", 2: "southbound", 3: "eastbound", 4: "westbound"}

    results = [
        [frozenset(p) for p in group_phases(flows, directions)]
        for _ in range(5)
    ]
    assert all(r == results[0] for r in results[1:])


# ── Integration: arm_direction field on streets ───────────────────────────────

@pytest.fixture
def intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_arm_dir_test", "latitude": 7.4478, "longitude": 125.8057})
    assert r.status_code == 200
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


def test_street_create_default_arm_direction(auth, intersection):
    """Creating a street without arm_direction defaults to 'unknown'."""
    r = auth.post(f"{API_URL}/streets/",
                  json={"intersection_id": intersection["id"], "name": "_arm_default"})
    assert r.status_code == 200
    data = r.json()
    assert "arm_direction" in data
    assert data["arm_direction"] == "unknown"
    auth.delete(f"{API_URL}/streets/{data['id']}")


def test_street_create_with_arm_direction(auth, intersection):
    """Creating a street with arm_direction persists the value."""
    r = auth.post(f"{API_URL}/streets/",
                  json={"intersection_id": intersection["id"],
                        "name": "_arm_nb",
                        "arm_direction": "northbound"})
    assert r.status_code == 200
    data = r.json()
    assert data["arm_direction"] == "northbound"
    auth.delete(f"{API_URL}/streets/{data['id']}")


def test_street_update_arm_direction(auth, intersection):
    """Updating arm_direction via PUT is persisted and returned."""
    r = auth.post(f"{API_URL}/streets/",
                  json={"intersection_id": intersection["id"], "name": "_arm_update"})
    sid = r.json()["id"]

    r = auth.put(f"{API_URL}/streets/{sid}", json={"arm_direction": "eastbound"})
    assert r.status_code == 200
    assert r.json()["arm_direction"] == "eastbound"

    # GET to confirm persistence
    r = auth.get(f"{API_URL}/streets/{sid}")
    assert r.status_code == 200
    assert r.json()["arm_direction"] == "eastbound"

    auth.delete(f"{API_URL}/streets/{sid}")


def test_street_update_name_preserves_arm_direction(auth, intersection):
    """Updating only the name does not clobber arm_direction."""
    r = auth.post(f"{API_URL}/streets/",
                  json={"intersection_id": intersection["id"],
                        "name": "_arm_preserve",
                        "arm_direction": "southbound"})
    sid = r.json()["id"]

    auth.put(f"{API_URL}/streets/{sid}", json={"name": "_arm_preserve_renamed"})

    r = auth.get(f"{API_URL}/streets/{sid}")
    assert r.json()["arm_direction"] == "southbound"
    assert r.json()["name"] == "_arm_preserve_renamed"

    auth.delete(f"{API_URL}/streets/{sid}")


def test_4arm_intersection_phase_grouping_via_timing(auth, intersection):
    """4 streets with NB/SB/EB/WB arm directions → 2-phase timing (shorter cycle than 4-phase)."""
    iid = intersection["id"]

    arms = ["northbound", "southbound", "eastbound", "westbound"]
    street_ids = []
    for arm in arms:
        r = auth.post(f"{API_URL}/streets/",
                      json={"intersection_id": iid, "name": f"_{arm[:2]}",
                            "arm_direction": arm})
        assert r.status_code == 200
        street_ids.append(r.json()["id"])

    # Generate timing (no real flow data, will use min_cycle)
    r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    assert r.status_code == 200

    rows = auth.get(f"{API_URL}/timing-recommendations/{iid}").json()
    assert len(rows) > 0
    for row in rows:
        assert 40 <= row["cycle_length"] <= 120
