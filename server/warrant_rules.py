"""MUTCD signal-warrant pure-function evaluators (Warrants 1, 2, 3, 4).

Used for synthetic-data label generation in the multi-task 1D-CNN training
pipeline (`docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md`).

All functions are DB-free and operate on a flow_matrix of shape (5, 96):
    flow_matrix[0] = NB approach,  PCU/hr rate per 15-min slot
    flow_matrix[1] = SB approach,  PCU/hr rate per 15-min slot
    flow_matrix[2] = EB approach,  PCU/hr rate per 15-min slot
    flow_matrix[3] = WB approach,  PCU/hr rate per 15-min slot
    flow_matrix[4] = pedestrian crossing volume, peds/hr rate per slot

Each slot is 15 minutes, so the per-hour volume during hour h is the mean of
the four slot rates for that hour (since each slot rate is already an hourly
rate).

The MUTCD low-speed multiplier of 0.70 (Section 4C.01) applies whenever the
85th-percentile speed (here approximated by `posted_speed_kph`) is ≤ 40 km/h.
Thresholds are applied to the *measured* hourly volume; equivalently, the
threshold itself is multiplied by 0.70 — that is what these helpers do.

References:
- MUTCD 2009 §4C.02, Table 4C-1  (Warrant 1: Eight-Hour Vehicular Volume)
- MUTCD 2009 §4C.03, Figure 4C-1 (Warrant 2: Four-Hour Vehicular Volume)
- MUTCD 2009 §4C.04, Figure 4C-3 (Warrant 3: Peak Hour)
- MUTCD 2009 §4C.05               (Warrant 4: Pedestrian Volume)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np


N_SLOTS_PER_HOUR = 4
N_HOURS = 24
LOW_SPEED_KPH_THRESHOLD = 40
LOW_SPEED_FACTOR = 0.70


# ── Metadata ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class IntersectionMeta:
    """Per-intersection metadata that conditions MUTCD warrant thresholds."""
    major_lanes: int          # {1, 2}
    minor_lanes: int          # {1, 2}
    posted_speed_kph: int     # {30, 40, 50}
    is_signalized: bool
    n_approaches: int         # {3, 4}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _hourly_volumes(slot_rates: np.ndarray) -> np.ndarray:
    """Reduce 96 per-slot hourly rates to 24 per-hour volumes by averaging.

    Each 15-min slot value is *already* an hourly rate, so the mean of four
    consecutive slots gives the equivalent hour-long volume.
    """
    if slot_rates.shape[-1] != N_SLOTS_PER_HOUR * N_HOURS:
        raise ValueError(
            f"Expected last dim of {N_SLOTS_PER_HOUR * N_HOURS} (96 slots), "
            f"got {slot_rates.shape[-1]}"
        )
    reshaped = slot_rates.reshape(*slot_rates.shape[:-1], N_HOURS, N_SLOTS_PER_HOUR)
    return reshaped.mean(axis=-1)


def _major_minor_axes(flow_matrix: np.ndarray) -> tuple[Literal["NS", "EW"], Literal["NS", "EW"]]:
    """Pick the major street axis as whichever pair (NB+SB vs EB+WB) has larger
    total daily volume. Returns (major_axis, minor_axis)."""
    ns_total = flow_matrix[0].sum() + flow_matrix[1].sum()
    ew_total = flow_matrix[2].sum() + flow_matrix[3].sum()
    if ns_total >= ew_total:
        return "NS", "EW"
    return "EW", "NS"


def _axis_hourly_both_directions(flow_matrix: np.ndarray, axis: str) -> np.ndarray:
    """Sum both directions of an axis to 24 hourly values."""
    if axis == "NS":
        return _hourly_volumes(flow_matrix[0] + flow_matrix[1])
    return _hourly_volumes(flow_matrix[2] + flow_matrix[3])


def _axis_hourly_higher_direction(flow_matrix: np.ndarray, axis: str) -> np.ndarray:
    """Return per-hour volume of the higher-volume direction of the axis."""
    if axis == "NS":
        nb = _hourly_volumes(flow_matrix[0])
        sb = _hourly_volumes(flow_matrix[1])
        return np.maximum(nb, sb)
    eb = _hourly_volumes(flow_matrix[2])
    wb = _hourly_volumes(flow_matrix[3])
    return np.maximum(eb, wb)


def _speed_factor(speed_kph: int) -> float:
    return LOW_SPEED_FACTOR if speed_kph <= LOW_SPEED_KPH_THRESHOLD else 1.0


# ── Threshold tables ─────────────────────────────────────────────────────────

# Table 4C-1 Condition A (Minimum Vehicular Volume):
#   key = (major_lanes_bucket, minor_lanes_bucket)
#   where bucket "1" = exactly 1 lane, "2+" = 2 or more lanes.
W1_COND_A_MAJOR = {
    ("1",  "1"):  500,
    ("2+", "1"):  600,
    ("2+", "2+"): 600,
    ("1",  "2+"): 500,
}
W1_COND_A_MINOR = {
    ("1",  "1"):  150,
    ("2+", "1"):  150,
    ("2+", "2+"): 200,
    ("1",  "2+"): 200,
}
# Table 4C-1 Condition B (Interruption of Continuous Traffic):
W1_COND_B_MAJOR = {
    ("1",  "1"):  750,
    ("2+", "1"):  900,
    ("2+", "2+"): 900,
    ("1",  "2+"): 750,
}
W1_COND_B_MINOR = {
    ("1",  "1"):  75,
    ("2+", "1"):  75,
    ("2+", "2+"): 100,
    ("1",  "2+"): 100,
}


def _lane_bucket(n_lanes: int) -> str:
    return "1" if n_lanes <= 1 else "2+"


def _w1_thresholds(meta: IntersectionMeta) -> tuple[float, float, float, float]:
    """Return (cond_A_major, cond_A_minor, cond_B_major, cond_B_minor) with
    the low-speed factor applied."""
    key = (_lane_bucket(meta.major_lanes), _lane_bucket(meta.minor_lanes))
    f = _speed_factor(meta.posted_speed_kph)
    return (
        W1_COND_A_MAJOR[key] * f,
        W1_COND_A_MINOR[key] * f,
        W1_COND_B_MAJOR[key] * f,
        W1_COND_B_MINOR[key] * f,
    )


# ── Warrant evaluators ───────────────────────────────────────────────────────

def evaluate_w1(flow_matrix: np.ndarray, meta: IntersectionMeta) -> tuple[bool, float]:
    """Warrant 1 — Eight-Hour Vehicular Volume (MUTCD §4C.02).

    Met when there are at least 8 hours in the day during which either
    Condition A (Minimum Vehicular Volume) or Condition B (Interruption of
    Continuous Traffic) is satisfied simultaneously on the major and minor
    streets.

    Confidence is the count of qualifying hours / 8, clipped to [0, 1].
    """
    major_axis, minor_axis = _major_minor_axes(flow_matrix)
    major_hourly = _axis_hourly_both_directions(flow_matrix, major_axis)
    minor_hourly = _axis_hourly_higher_direction(flow_matrix, minor_axis)

    a_maj, a_min, b_maj, b_min = _w1_thresholds(meta)
    cond_a = (major_hourly >= a_maj) & (minor_hourly >= a_min)
    cond_b = (major_hourly >= b_maj) & (minor_hourly >= b_min)
    qualifying = int(np.sum(cond_a | cond_b))

    met = qualifying >= 8
    confidence = round(min(1.0, qualifying / 8.0), 4)
    return met, confidence


def evaluate_w2(flow_matrix: np.ndarray, meta: IntersectionMeta) -> tuple[bool, float]:
    """Warrant 2 — Four-Hour Vehicular Volume (MUTCD §4C.03, Figure 4C-1).

    Approximation of Figure 4C-1 by a piecewise-linear threshold curve fit to
    the published 1-lane and 2+-lane minor-street boundary lines:
        minor_threshold(major) = max(MINOR_FLOOR, INTERCEPT - SLOPE * major)
    Constants chosen so the threshold matches the chart corners; documented
    in methods chapter.
    """
    major_axis, minor_axis = _major_minor_axes(flow_matrix)
    major_hourly = _axis_hourly_both_directions(flow_matrix, major_axis)
    minor_hourly = _axis_hourly_higher_direction(flow_matrix, minor_axis)

    # Figure 4C-1 piecewise-linear fit (per-direction major-street vph on the
    # x-axis of the published chart; here we use both-directions, so divide).
    major_per_dir = major_hourly / 2.0
    minor_floor = 100.0 if meta.minor_lanes >= 2 else 75.0
    intercept = 500.0 if meta.minor_lanes >= 2 else 400.0
    slope = 0.35
    raw_minor_threshold = np.maximum(minor_floor, intercept - slope * major_per_dir)

    f = _speed_factor(meta.posted_speed_kph)
    minor_threshold = raw_minor_threshold * f

    qualifying = int(np.sum(minor_hourly >= minor_threshold))
    met = qualifying >= 4
    confidence = round(min(1.0, qualifying / 4.0), 4)
    return met, confidence


def evaluate_w3(flow_matrix: np.ndarray, meta: IntersectionMeta) -> tuple[bool, float]:
    """Warrant 3 — Peak Hour (MUTCD §4C.04, Figure 4C-3).

    Met when during the single peak hour (highest major-street volume) the
    minor-street volume exceeds an approximation of the Figure 4C-3 curve.
    Thresholds are tighter than W2 (peak-hour curves sit ~150 vph above the
    four-hour curves on the published charts).
    """
    major_axis, minor_axis = _major_minor_axes(flow_matrix)
    major_hourly = _axis_hourly_both_directions(flow_matrix, major_axis)
    minor_hourly = _axis_hourly_higher_direction(flow_matrix, minor_axis)

    peak_idx = int(np.argmax(major_hourly))
    peak_major_per_dir = major_hourly[peak_idx] / 2.0
    peak_minor = minor_hourly[peak_idx]

    # Figure 4C-3 piecewise-linear fit, ~150 vph above the W2 curve.
    minor_floor = 150.0 if meta.minor_lanes >= 2 else 100.0
    intercept = 650.0 if meta.minor_lanes >= 2 else 550.0
    slope = 0.35
    raw_threshold = max(minor_floor, intercept - slope * peak_major_per_dir)
    threshold = raw_threshold * _speed_factor(meta.posted_speed_kph)

    met = bool(peak_minor >= threshold)
    confidence = round(min(1.0, peak_minor / threshold) if threshold > 0 else 0.0, 4)
    return met, confidence


def evaluate_w4(flow_matrix: np.ndarray, meta: IntersectionMeta) -> tuple[bool, float]:
    """Warrant 4 — Pedestrian Volume (MUTCD §4C.05).

    Met when EITHER:
      - pedestrian volume ≥ 107 peds/hr for each of any 4 hours, OR
      - pedestrian volume ≥ 133 peds/hr for any 1 hour.
    Low-speed factor applies to both thresholds.
    """
    ped_hourly = _hourly_volumes(flow_matrix[4])
    f = _speed_factor(meta.posted_speed_kph)
    four_hr_threshold = 107.0 * f
    one_hr_threshold = 133.0 * f

    n_four = int(np.sum(ped_hourly >= four_hr_threshold))
    peak_ped = float(ped_hourly.max())

    met_4hr = n_four >= 4
    met_1hr = peak_ped >= one_hr_threshold
    met = met_4hr or met_1hr

    conf_4hr = min(1.0, n_four / 4.0)
    conf_1hr = min(1.0, peak_ped / one_hr_threshold) if one_hr_threshold > 0 else 0.0
    confidence = round(max(conf_4hr, conf_1hr), 4)
    return met, confidence


# ── Public bundle ────────────────────────────────────────────────────────────

WARRANT_NAMES: tuple[str, ...] = ("w1", "w2", "w3", "w4")


def evaluate_all_mutcd(
    flow_matrix: np.ndarray,
    meta: IntersectionMeta,
) -> dict[str, tuple[bool, float]]:
    """Run W1–W4 in one call. Returns {warrant_name: (met, confidence)}."""
    return {
        "w1": evaluate_w1(flow_matrix, meta),
        "w2": evaluate_w2(flow_matrix, meta),
        "w3": evaluate_w3(flow_matrix, meta),
        "w4": evaluate_w4(flow_matrix, meta),
    }
