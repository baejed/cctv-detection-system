"""Unit tests for MUTCD warrant rule evaluators (W1–W4).

These are pure-function tests - no DB, no FastAPI app. Mirrors the style of
`tests/test_local_warrants.py` for the existing W-Local rules.
"""
from __future__ import annotations

import numpy as np
import pytest

from server.warrant_rules import (
    IntersectionMeta,
    WARRANT_NAMES,
    evaluate_all_mutcd,
    evaluate_w1,
    evaluate_w2,
    evaluate_w3,
    evaluate_w4,
    _hourly_volumes,
    _major_minor_axes,
    _speed_factor,
)


# ── Fixtures / builders ──────────────────────────────────────────────────────

def _meta(
    major_lanes: int = 1,
    minor_lanes: int = 1,
    posted_speed_kph: int = 50,
    is_signalized: bool = False,
    n_approaches: int = 4,
) -> IntersectionMeta:
    return IntersectionMeta(
        major_lanes=major_lanes,
        minor_lanes=minor_lanes,
        posted_speed_kph=posted_speed_kph,
        is_signalized=is_signalized,
        n_approaches=n_approaches,
    )


def _flat_flow_matrix(
    nb: float = 0.0,
    sb: float = 0.0,
    eb: float = 0.0,
    wb: float = 0.0,
    ped: float = 0.0,
) -> np.ndarray:
    """Build a (5, 96) matrix with a constant value per channel."""
    mat = np.zeros((5, 96), dtype=np.float32)
    mat[0, :] = nb
    mat[1, :] = sb
    mat[2, :] = eb
    mat[3, :] = wb
    mat[4, :] = ped
    return mat


def _flow_with_peak_hours(
    base_per_dir: float,
    peak_per_dir: float,
    peak_minor: float,
    n_peak_hours: int,
    axis: str = "NS",
) -> np.ndarray:
    """Build a flow matrix where `n_peak_hours` non-overlapping hours have
    elevated volume on both the major-axis directions and on one minor-axis
    direction. The remaining hours are at `base_per_dir`."""
    mat = _flat_flow_matrix()
    if axis == "NS":
        mat[0, :] = base_per_dir
        mat[1, :] = base_per_dir
        mat[2, :] = 0.0
        mat[3, :] = 0.0
        minor_idx = 2  # EB carries the minor-street volume
    else:
        mat[2, :] = base_per_dir
        mat[3, :] = base_per_dir
        mat[0, :] = 0.0
        mat[1, :] = 0.0
        minor_idx = 0

    for h in range(n_peak_hours):
        s = h * 4
        e = s + 4
        if axis == "NS":
            mat[0, s:e] = peak_per_dir
            mat[1, s:e] = peak_per_dir
        else:
            mat[2, s:e] = peak_per_dir
            mat[3, s:e] = peak_per_dir
        mat[minor_idx, s:e] = peak_minor
    return mat


# ── Helper-level tests ───────────────────────────────────────────────────────

def test_hourly_volumes_reduces_96_to_24():
    rates = np.arange(96, dtype=np.float32)
    hourly = _hourly_volumes(rates)
    assert hourly.shape == (24,)
    # Hour 0 = mean of slots [0,1,2,3] = 1.5
    assert hourly[0] == pytest.approx(1.5)


def test_major_minor_axes_picks_ns_when_ns_dominant():
    mat = _flat_flow_matrix(nb=400, sb=400, eb=50, wb=50)
    major, minor = _major_minor_axes(mat)
    assert major == "NS"
    assert minor == "EW"


def test_major_minor_axes_picks_ew_when_ew_dominant():
    mat = _flat_flow_matrix(nb=50, sb=50, eb=400, wb=400)
    major, minor = _major_minor_axes(mat)
    assert major == "EW"
    assert minor == "NS"


def test_speed_factor_low_speed():
    assert _speed_factor(30) == 0.70
    assert _speed_factor(40) == 0.70
    assert _speed_factor(50) == 1.00


# ── Warrant 1 (eight-hour) ───────────────────────────────────────────────────

def test_w1_triggered_by_eight_qualifying_hours():
    # Sustained 600/dir major + 200/dir minor for 10 hours of the day:
    # major both-directions = 1200 ≥ 500 (Cond A); minor higher-dir = 200 ≥ 150.
    mat = _flow_with_peak_hours(
        base_per_dir=50,
        peak_per_dir=600,
        peak_minor=200,
        n_peak_hours=10,
    )
    met, conf = evaluate_w1(mat, _meta(posted_speed_kph=50))
    assert met is True
    assert conf == 1.0


def test_w1_not_triggered_with_only_seven_qualifying_hours():
    mat = _flow_with_peak_hours(
        base_per_dir=50,
        peak_per_dir=600,
        peak_minor=200,
        n_peak_hours=7,
    )
    met, conf = evaluate_w1(mat, _meta(posted_speed_kph=50))
    assert met is False
    assert conf == pytest.approx(7 / 8, abs=1e-3)


def test_w1_low_speed_multiplier_relaxes_threshold():
    # Volumes that would NOT qualify at 50 kph (major both-dirs = 700, below 500
    # threshold? actually 700 ≥ 500 - pick volumes below the std threshold and
    # above the 0.70-scaled threshold to isolate the effect):
    # 0.70 * 500 = 350 ; 0.70 * 150 = 105
    mat = _flow_with_peak_hours(
        base_per_dir=30,
        peak_per_dir=200,     # both dirs sum = 400 ≥ 350 (low-speed) but < 500 (std)
        peak_minor=120,       # ≥ 105 (low-speed) but < 150 (std)
        n_peak_hours=9,
    )
    met_low, _ = evaluate_w1(mat, _meta(posted_speed_kph=30))
    met_std, _ = evaluate_w1(mat, _meta(posted_speed_kph=50))
    assert met_low is True
    assert met_std is False


def test_w1_silent_intersection_not_triggered():
    mat = _flat_flow_matrix(nb=10, sb=10, eb=5, wb=5)
    met, conf = evaluate_w1(mat, _meta(posted_speed_kph=50))
    assert met is False
    assert conf == 0.0


def test_w1_lane_count_affects_threshold():
    # 2+ lane minor street raises the Cond-A minor threshold from 150 → 200.
    # Pick major both-dirs in (500, 750) so Cond-B (major ≥ 750) is also out
    # of reach - isolating Cond-A's minor threshold as the differentiator.
    mat = _flow_with_peak_hours(
        base_per_dir=30,
        peak_per_dir=300,    # both-dirs = 600: above Cond-A (500) but below Cond-B (750)
        peak_minor=170,      # ≥ 150 (1-lane minor) but < 200 (2-lane minor)
        n_peak_hours=10,
    )
    met_1lane, _ = evaluate_w1(mat, _meta(major_lanes=1, minor_lanes=1, posted_speed_kph=50))
    met_2lane, _ = evaluate_w1(mat, _meta(major_lanes=1, minor_lanes=2, posted_speed_kph=50))
    assert met_1lane is True
    assert met_2lane is False


# ── Warrant 2 (four-hour) ────────────────────────────────────────────────────

def test_w2_triggered_when_four_hours_above_curve():
    # Pick volumes well clear of the curve to avoid fit sensitivity:
    # major both-dirs = 1600 (per-dir 800), minor = 250.
    mat = _flow_with_peak_hours(
        base_per_dir=20,
        peak_per_dir=800,
        peak_minor=300,
        n_peak_hours=5,
    )
    met, conf = evaluate_w2(mat, _meta(posted_speed_kph=50))
    assert met is True
    assert conf == 1.0


def test_w2_not_triggered_with_only_three_qualifying_hours():
    mat = _flow_with_peak_hours(
        base_per_dir=20,
        peak_per_dir=800,
        peak_minor=300,
        n_peak_hours=3,
    )
    met, conf = evaluate_w2(mat, _meta(posted_speed_kph=50))
    assert met is False
    assert conf == pytest.approx(3 / 4, abs=1e-3)


def test_w2_floor_prevents_zero_minor_passing():
    # Even with very high major-street volume, a zero-minor hour cannot pass
    # the minor_floor (75 vph).
    mat = _flow_with_peak_hours(
        base_per_dir=20,
        peak_per_dir=2000,
        peak_minor=10,
        n_peak_hours=5,
    )
    met, _ = evaluate_w2(mat, _meta(posted_speed_kph=50))
    assert met is False


# ── Warrant 3 (peak hour) ────────────────────────────────────────────────────

def test_w3_triggered_at_extreme_peak():
    # Need to clear the peak-hour curve which sits ~150 vph above W2's.
    # Use a strong, isolated peak so the single peak hour qualifies.
    mat = _flow_with_peak_hours(
        base_per_dir=50,
        peak_per_dir=1000,
        peak_minor=500,
        n_peak_hours=1,
    )
    met, conf = evaluate_w3(mat, _meta(posted_speed_kph=50))
    assert met is True
    assert conf >= 1.0


def test_w3_not_triggered_at_modest_peak():
    mat = _flow_with_peak_hours(
        base_per_dir=50,
        peak_per_dir=300,
        peak_minor=80,
        n_peak_hours=1,
    )
    met, _ = evaluate_w3(mat, _meta(posted_speed_kph=50))
    assert met is False


# ── Warrant 4 (pedestrian) ───────────────────────────────────────────────────

def test_w4_triggered_by_four_hours_above_107():
    mat = _flat_flow_matrix(nb=100, sb=100, eb=20, wb=20, ped=0)
    # Inject 4 hours of pedestrian volume above 107 ped/hr.
    for h in range(4):
        mat[4, h * 4:(h + 1) * 4] = 120.0
    met, conf = evaluate_w4(mat, _meta(posted_speed_kph=50))
    assert met is True
    assert conf == 1.0


def test_w4_triggered_by_single_extreme_hour():
    mat = _flat_flow_matrix(nb=100, sb=100, eb=20, wb=20, ped=0)
    mat[4, 0:4] = 200.0  # one hour at 200 ped/hr ≥ 133
    met, _ = evaluate_w4(mat, _meta(posted_speed_kph=50))
    assert met is True


def test_w4_not_triggered_by_low_pedestrian_volume():
    mat = _flat_flow_matrix(nb=100, sb=100, eb=20, wb=20, ped=20)
    met, conf = evaluate_w4(mat, _meta(posted_speed_kph=50))
    assert met is False
    assert conf < 1.0


def test_w4_low_speed_multiplier_relaxes_threshold():
    # 4 hours at 80 ped/hr: above 107 * 0.70 = 74.9 but below 107.
    mat = _flat_flow_matrix(nb=100, sb=100, eb=20, wb=20, ped=0)
    for h in range(4):
        mat[4, h * 4:(h + 1) * 4] = 80.0
    met_low, _ = evaluate_w4(mat, _meta(posted_speed_kph=30))
    met_std, _ = evaluate_w4(mat, _meta(posted_speed_kph=50))
    assert met_low is True
    assert met_std is False


# ── Aggregate API ────────────────────────────────────────────────────────────

def test_evaluate_all_mutcd_returns_all_warrants():
    mat = _flat_flow_matrix(nb=200, sb=200, eb=50, wb=50, ped=10)
    results = evaluate_all_mutcd(mat, _meta(posted_speed_kph=50))
    assert set(results.keys()) == set(WARRANT_NAMES)
    for name, (met, conf) in results.items():
        assert isinstance(met, bool)
        assert 0.0 <= conf <= 1.0


def test_evaluate_all_mutcd_silent_intersection_all_negative():
    mat = _flat_flow_matrix(nb=5, sb=5, eb=5, wb=5, ped=1)
    results = evaluate_all_mutcd(mat, _meta(posted_speed_kph=50))
    for met, _ in results.values():
        assert met is False
