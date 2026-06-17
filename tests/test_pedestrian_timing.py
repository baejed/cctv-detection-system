"""Tests for pedestrian minimum green time constraint in Webster's formula.

All tests are pure unit tests - no live stack required.

DPWH pedestrian minimum green:
    G_ped = crossing_width_m / 1.2 + 7.0
where 1.2 m/s is DPWH standard pedestrian walking speed and 7 s covers
the walk + flashing don't-walk clearance interval.
"""
import pytest


PED_SPEED_MS = 1.2   # DPWH pedestrian walking speed (m/s)
CLEARANCE_S  = 7.0   # walk + flashing don't-walk (seconds)


def ped_min(width_m: float) -> float:
    return width_m / PED_SPEED_MS + CLEARANCE_S


# ── Pedestrian minimum enforced ───────────────────────────────────────────────

def test_ped_min_enforced_low_flow():
    """Very low vehicle flow produces short Webster green - ped min must override it."""
    from server.webster import compute_timing

    flows  = {1: 30.0, 2: 30.0}
    phases = [[1], [2]]

    _, splits = compute_timing(flows, phases, crossing_width_m=12.0)

    expected = ped_min(12.0)   # 12 / 1.2 + 7 = 17.0 s
    assert splits[1] >= expected, f"Phase 1 green {splits[1]:.1f} < ped min {expected:.1f}"
    assert splits[2] >= expected, f"Phase 2 green {splits[2]:.1f} < ped min {expected:.1f}"


def test_ped_min_not_binding_at_high_flow():
    """High vehicle flow already exceeds ped min - timing driven by traffic, not peds."""
    from server.webster import compute_timing

    flows  = {1: 900.0, 2: 900.0}
    phases = [[1], [2]]

    _, splits = compute_timing(flows, phases, crossing_width_m=12.0)

    expected = ped_min(12.0)
    # Both phases should be ≥ ped_min (trivially) AND the cycle should reflect
    # traffic demand, not just the pedestrian floor
    assert splits[1] >= expected
    assert splits[2] >= expected
    # With 900 PCU/hr per approach out of 1400 saturation, Y = 1.29 → max_cycle
    # So greens should be well above 17 s
    assert splits[1] > 20.0


def test_narrow_road_shorter_ped_min():
    """Narrow 6 m crossing requires less minimum green than wide 18 m crossing."""
    from server.webster import compute_timing

    flows  = {1: 50.0, 2: 50.0}
    phases = [[1], [2]]

    _, splits_6m  = compute_timing(flows, phases, crossing_width_m=6.0)
    _, splits_18m = compute_timing(flows, phases, crossing_width_m=18.0)

    assert splits_6m[1]  >= ped_min(6.0)   # 6/1.2 + 7 = 12.0 s
    assert splits_18m[1] >= ped_min(18.0)  # 18/1.2 + 7 = 22.0 s
    assert splits_18m[1] > splits_6m[1], "Wider road must produce longer minimum green"


def test_ped_min_applied_per_phase_independently():
    """Each phase independently satisfies ped min - imbalanced flows still enforce both."""
    from server.webster import compute_timing

    # Phase 1 has dominant flow (would normally get most of the green),
    # phase 2 has almost no flow and would get a tiny slice without ped constraint
    flows  = {1: 700.0, 2: 5.0}
    phases = [[1], [2]]

    _, splits = compute_timing(flows, phases, crossing_width_m=12.0)

    expected = ped_min(12.0)
    assert splits[1] >= expected, "High-flow phase must still meet ped min"
    assert splits[2] >= expected, "Low-flow phase must be lifted to ped min"


def test_cycle_extends_when_ped_constraint_binding():
    """When ped min is binding, cycle grows beyond Webster's C_opt."""
    from server.webster import compute_timing

    # Very low flow: Webster C_opt ≈ min_cycle (40 s), greens would be tiny
    flows       = {1: 10.0, 2: 10.0}
    phases      = [[1], [2]]
    lost_time   = 4
    all_red     = 3

    cycle_no_ped, _ = compute_timing(flows, phases, lost_time, all_red, crossing_width_m=0.0)
    cycle_ped,    _ = compute_timing(flows, phases, lost_time, all_red, crossing_width_m=12.0)

    # With crossing_width_m=0, ped_min = 7 s; some cycles may still be fine.
    # With 12 m crossing, ped_min = 17 s per phase → forces a longer cycle.
    assert cycle_ped >= cycle_no_ped, "Pedestrian constraint must not shorten the cycle"


def test_default_crossing_width_used_when_not_provided():
    """compute_timing default crossing_width_m=12.0 matches explicit call."""
    from server.webster import compute_timing

    flows  = {1: 50.0, 2: 50.0}
    phases = [[1], [2]]

    cycle_default,  splits_default  = compute_timing(flows, phases)
    cycle_explicit, splits_explicit = compute_timing(flows, phases, crossing_width_m=12.0)

    assert cycle_default  == cycle_explicit
    assert splits_default == splits_explicit


def test_zero_flows_returns_min_cycle_with_ped_min():
    """No flow intersections return min_cycle; ped min still must be satisfiable."""
    from server.webster import compute_timing

    cycle, splits = compute_timing({}, crossing_width_m=12.0)

    assert cycle == 40   # min_cycle default
    assert splits == {}


def test_ped_min_clamped_to_max_cycle():
    """Extremely wide crossing (100 m) is capped at max_cycle, not rejected."""
    from server.webster import compute_timing

    flows  = {1: 50.0, 2: 50.0}
    phases = [[1], [2]]

    cycle, splits = compute_timing(flows, phases, crossing_width_m=100.0, max_cycle=120)

    assert cycle <= 120, "Cycle must not exceed max_cycle even for very wide crossings"
    # Ped min = 100/1.2 + 7 ≈ 90 s per phase - unachievable in a 120 s cycle with 2
    # phases plus lost time, so we accept the max_cycle cap
    assert cycle == 120


# ── Phase grouping interaction ────────────────────────────────────────────────

def test_ped_min_with_paired_phases():
    """4-arm intersection: 2 paired phases, ped min applied to each pair."""
    from server.webster import compute_timing, group_phases

    flows      = {1: 400.0, 2: 380.0, 3: 300.0, 4: 290.0}
    directions = {1: "northbound", 2: "southbound", 3: "eastbound", 4: "westbound"}
    phases     = group_phases(flows, directions)  # → [[1,2], [3,4]]

    _, splits = compute_timing(flows, phases, crossing_width_m=12.0)

    expected = ped_min(12.0)
    for sid in flows:
        assert splits[sid] >= expected, f"Street {sid}: {splits[sid]:.1f} < ped min {expected:.1f}"


# ── Additional edge-case tests (from stress-test plan) ───────────────────────

def test_compute_timing_single_phase_ped_min():
    """Single-approach intersection still gets ped min on its one phase."""
    from server.webster import compute_timing

    flows  = {1: 200.0}
    phases = [[1]]

    _, splits = compute_timing(flows, phases, crossing_width_m=12.0)

    assert splits[1] >= ped_min(12.0)


def test_compute_timing_ped_min_with_custom_lost_time():
    """Ped min interacts correctly with non-default lost_time_per_phase and all_red_clearance."""
    from server.webster import compute_timing

    flows  = {1: 50.0, 2: 50.0}
    phases = [[1], [2]]

    # L = 2 × (6 + 5) = 22; ped_min = 17 s; C = 22 + 2×17 = 56
    cycle, splits = compute_timing(
        flows, phases,
        lost_time_per_phase=6,
        all_red_clearance=5,
        crossing_width_m=12.0,
    )

    assert splits[1] >= ped_min(12.0)
    assert splits[2] >= ped_min(12.0)
    assert cycle >= 56


def test_crossing_width_in_schema_response():
    """IntersectionResponse serialises a non-default crossing_width_m correctly."""
    from server.schemas import IntersectionResponse
    from datetime import datetime

    r = IntersectionResponse(
        id=1, name="test", latitude=7.0, longitude=125.0,
        crossing_width_m=15.0, time=datetime.now(),
    )
    assert r.crossing_width_m == 15.0


def test_crossing_width_default_in_schema():
    """IntersectionResponse defaults crossing_width_m to 12.0 when omitted."""
    from server.schemas import IntersectionResponse
    from datetime import datetime

    r = IntersectionResponse(
        id=1, name="test", latitude=7.0, longitude=125.0,
        time=datetime.now(),
    )
    assert r.crossing_width_m == 12.0
