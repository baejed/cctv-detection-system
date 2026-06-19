"""Synthetic traffic data generator for the multi-task 1D-CNN training pipeline.

Implements the parent-plan Phase 1 generator
(`docs/superpowers/plans/2026-06-18-tod-clustering-thesis.md`) together with
the PRD §Synthetic data extensions deltas required by
`docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md`:

  * **Pedestrian channel** — a 5th input channel using a Philippine urban
    weekday pattern (morning, lunch, evening peaks).
  * **Intersection metadata sampling** — `IntersectionMeta(major_lanes,
    minor_lanes, posted_speed_kph, is_signalized, n_approaches)` drawn from
    Tagum-realistic priors.
  * **Per-sample labels (T06)** — emit MUTCD W1–W4 + W-Local 2/3 warrant
    results, Webster's critical v/c, and the precedence-derived intervention
    class alongside every (flow_matrix, metadata) draw.

The output flow matrix is shape ``(5, 96)`` (channels-first, matching
`server.warrant_rules` and the PRD's CNN input convention):

  ===========  ============================================
  channel      meaning
  ===========  ============================================
  0            NB approach volume (PCU/hr)
  1            SB approach volume (PCU/hr)
  2            EB approach volume (PCU/hr)
  3            WB approach volume (PCU/hr)
  4            pedestrian crossing volume (peds/hr)
  ===========  ============================================

Each value is the average hourly rate during a 15-min slot — the same
convention `server.warrant_rules._hourly_volumes` expects when reducing slots
to hourly volumes for MUTCD threshold evaluation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

import numpy as np

from server.intervention_rules import assign_intervention_label
from server.local_warrants import (
    DEFAULT_W_LOCAL_2_THRESHOLD,
    DEFAULT_W_LOCAL_3_MIN_PCU,
    _compute_w_local_2,
    _compute_w_local_3,
)
from server.warrant_rules import IntersectionMeta, evaluate_all_mutcd


N_SLOTS = 96
N_VEHICLE_CHANNELS = 4
PED_CHANNEL_INDEX = 4
N_CHANNELS = N_VEHICLE_CHANNELS + 1  # 5 = 4 approaches + pedestrians


# ── Vehicle regimes (parent-plan Phase 1) ────────────────────────────────────

# PCU/hr per (NB, SB, EB, WB). Calibrated so that — combined with
# `sample_intersection_modifier`'s skewed scale distribution — the synthetic
# dataset emits the PRD-required class balance: ~50–65% timing_only, ~30–40%
# signalize, <10% road_widening (see §Implementation Decisions / Class
# imbalance and §Risks in the PRD).
#
# Per-regime sums (NB+SB+EB+WB) chosen so that a "typical" intersection
# (`intersection_modifier` ≈ 1.0) produces a Webster's critical v/c around
# 0.5, while the modifier's long upper tail occasionally drives v/c above the
# 0.90 road-widening threshold. Directional asymmetry reflects typical
# AM-inbound / PM-outbound commute patterns; OFF_PEAK is kept high enough that
# W-Local 3 ("lights off") does not fire on every modest intersection.
GROUND_TRUTH_REGIMES: Mapping[str, tuple[int, int, int, int]] = {
    "AM_RUSH":  (280,  85, 235, 100),
    "MIDDAY":   (150, 135, 145, 140),
    "PM_RUSH":  ( 85, 280, 100, 235),
    "OFF_PEAK": ( 60,  55,  58,  52),
}


def regime_for_slot(slot_index: int) -> str:
    """Map a 15-min slot index in [0, 96) to its weekday ground-truth regime."""
    minutes = slot_index * 15
    if 360 <= minutes < 600:    return "AM_RUSH"     # 06:00–10:00
    if 600 <= minutes < 900:    return "MIDDAY"      # 10:00–15:00
    if 900 <= minutes < 1140:   return "PM_RUSH"     # 15:00–19:00
    return "OFF_PEAK"


# ── Pedestrian regime (PRD T05 extension) ────────────────────────────────────

# peds/hr by named regime. Tagum-realistic Philippine urban weekday:
#   * morning school/commute peak ~07:00–08:30
#   * lunch peak ~11:30–13:30
#   * evening commute + dinner peak ~17:00–19:00
#   * low-but-nonzero pedestrian activity during the rest of waking hours
#   * very low overnight
#
# Peak amplitudes calibrated so that W4 (MUTCD pedestrian volume) fires on a
# realistic minority of intersections (roughly 15–30% across seeds), not on
# almost every intersection as would happen if peak peds approached the
# 133 peds/hr 1-hour threshold un-scaled.
PED_PROFILES: Mapping[str, int] = {
    "AM_PED":      75,
    "LUNCH":       50,
    "PM_PED":      85,
    "DAY_LOW":     22,
    "NIGHT_LOW":    5,
}


def ped_regime_for_slot(slot_index: int) -> str:
    """Map a 15-min slot index in [0, 96) to its pedestrian regime label."""
    minutes = slot_index * 15
    if 420 <= minutes < 510:    return "AM_PED"      # 07:00–08:30
    if 690 <= minutes < 810:    return "LUNCH"       # 11:30–13:30
    if 1020 <= minutes < 1140:  return "PM_PED"      # 17:00–19:00
    if 360 <= minutes < 1260:   return "DAY_LOW"     # 06:00–21:00
    return "NIGHT_LOW"


# ── Per-slot sampling ────────────────────────────────────────────────────────

def sample_flow_for_slot(
    regime: str,
    dow_modifier: float,
    rng: np.random.Generator,
) -> tuple[float, float, float, float]:
    """Sample one slot of (NB, SB, EB, WB) PCU/hr given a regime label.

    ±10% Gaussian noise per approach, multiplied by a daily modifier already
    drawn once per day.
    """
    base = GROUND_TRUTH_REGIMES[regime]
    noise = rng.normal(0, 0.10, size=4)
    return tuple(float(max(0.0, b * dow_modifier * (1.0 + n))) for b, n in zip(base, noise))


def sample_ped_for_slot(
    ped_regime: str,
    ped_dow_modifier: float,
    rng: np.random.Generator,
) -> float:
    """Sample one slot of pedestrian crossing volume (peds/hr).

    Pedestrian counts are noisier than vehicle counts in practice (smaller
    populations per slot), so noise scale is ±15% vs. vehicles' ±10%.
    """
    base = PED_PROFILES[ped_regime]
    noise = float(rng.normal(0, 0.15))
    return float(max(0.0, base * ped_dow_modifier * (1.0 + noise)))


# ── Per-day flow matrix ──────────────────────────────────────────────────────

def generate_day_flow_matrix(
    rng: np.random.Generator,
    is_weekend: bool = False,
    intersection_modifier: np.ndarray | None = None,
) -> np.ndarray:
    """Generate one ``(5, 96)`` flow matrix for a single intersection × day.

    Parameters
    ----------
    rng : np.random.Generator
        Caller-supplied RNG so the generator is fully deterministic given a
        seed.
    is_weekend : bool
        On weekends the AM/PM vehicle rush windows collapse to MIDDAY (flatter
        schedule, per parent plan Phase 1 Task 2 Step 3). Pedestrian peaks are
        likewise softened to LUNCH-level activity.
    intersection_modifier : np.ndarray, optional
        Length-4 per-approach multiplier that bakes in per-intersection
        variation (default: all-ones). Use `sample_intersection_modifier`
        to draw one.

    Returns
    -------
    np.ndarray
        Shape ``(5, 96)``, dtype float64. Channels-first.
    """
    if intersection_modifier is None:
        intersection_modifier = np.ones(N_VEHICLE_CHANNELS, dtype=np.float64)
    if intersection_modifier.shape != (N_VEHICLE_CHANNELS,):
        raise ValueError(
            f"intersection_modifier must have shape ({N_VEHICLE_CHANNELS},), "
            f"got {intersection_modifier.shape}"
        )

    flow = np.zeros((N_CHANNELS, N_SLOTS), dtype=np.float64)
    dow_modifier = 1.0 + float(rng.normal(0, 0.05))
    ped_dow_modifier = 1.0 + float(rng.normal(0, 0.05))

    for s in range(N_SLOTS):
        veh_regime = regime_for_slot(s)
        if is_weekend and veh_regime in ("AM_RUSH", "PM_RUSH"):
            veh_regime = "MIDDAY"
        nb, sb, eb, wb = sample_flow_for_slot(veh_regime, dow_modifier, rng)
        flow[0, s] = nb * intersection_modifier[0]
        flow[1, s] = sb * intersection_modifier[1]
        flow[2, s] = eb * intersection_modifier[2]
        flow[3, s] = wb * intersection_modifier[3]

        ped_regime = ped_regime_for_slot(s)
        if is_weekend and ped_regime in ("AM_PED", "PM_PED"):
            ped_regime = "LUNCH"
        flow[PED_CHANNEL_INDEX, s] = sample_ped_for_slot(
            ped_regime, ped_dow_modifier, rng
        )

    return flow


# ── Intersection metadata sampling ───────────────────────────────────────────

# Tagum-realistic priors (cited in methods chapter):
#   * Major streets: ~60% have 2 lanes per direction (urban arterials), ~40% have 1.
#   * Minor streets: ~70% have 1 lane, ~30% have 2 (cross-streets are mostly local).
#   * Posted speed: skewed to 40 km/h (Tagum urban arterial default); 30 km/h for
#     barangay roads, 50 km/h for the few wider corridors.
#   * Signalized: only ~25% of city intersections are signalized today.
#   * n_approaches: 4-leg ~80%, 3-leg (T-intersection) ~20%.
_MAJOR_LANE_PROBS: Mapping[int, float] = {1: 0.40, 2: 0.60}
_MINOR_LANE_PROBS: Mapping[int, float] = {1: 0.70, 2: 0.30}
_SPEED_PROBS:      Mapping[int, float] = {30: 0.20, 40: 0.55, 50: 0.25}
_APPROACH_PROBS:   Mapping[int, float] = {3: 0.20, 4: 0.80}
_SIGNALIZED_PROB = 0.25


def _sample_int_categorical(
    rng: np.random.Generator, choices_probs: Mapping[int, float]
) -> int:
    keys = np.fromiter(choices_probs.keys(), dtype=np.int64)
    probs = np.fromiter(choices_probs.values(), dtype=np.float64)
    probs = probs / probs.sum()
    return int(rng.choice(keys, p=probs))


def sample_intersection_meta(rng: np.random.Generator) -> IntersectionMeta:
    """Sample one IntersectionMeta from the Tagum-realistic priors."""
    return IntersectionMeta(
        major_lanes=_sample_int_categorical(rng, _MAJOR_LANE_PROBS),
        minor_lanes=_sample_int_categorical(rng, _MINOR_LANE_PROBS),
        posted_speed_kph=_sample_int_categorical(rng, _SPEED_PROBS),
        is_signalized=bool(rng.random() < _SIGNALIZED_PROB),
        n_approaches=_sample_int_categorical(rng, _APPROACH_PROBS),
    )


# Per-intersection scale distribution. Triangular skewed toward smaller
# intersections (mode 0.7) with a long upper tail to 2.3 — the upper tail
# is what occasionally drives `critical_vc_for_day` above the 0.90
# road-widening threshold, while the bulk near 0.7 keeps most intersections
# in `timing_only` / `signalize` territory. Tuned together with
# `GROUND_TRUTH_REGIMES` and `PED_PROFILES` to hit the PRD's class balance.
_INTERSECTION_SCALE_LOW  = 0.25
_INTERSECTION_SCALE_MODE = 0.70
_INTERSECTION_SCALE_HIGH = 2.30
# Per-approach directional variation applied on top of the per-intersection
# scale; keeps NB/SB/EB/WB independently noisy without changing the
# intersection's overall size.
_DIRECTIONAL_VAR_LOW  = 0.85
_DIRECTIONAL_VAR_HIGH = 1.15


def sample_intersection_modifier(rng: np.random.Generator) -> np.ndarray:
    """Per-approach multiplier for per-intersection variation.

    Combines a single per-intersection ``scale`` drawn from a triangular
    distribution (skewed toward smaller intersections, with a long upper tail
    that drives the rare ``road_widening`` cases) with an independent
    per-approach directional variation in ``[0.85, 1.15]``. Returned as a
    length-4 float array so it slots directly into `generate_day_flow_matrix`.
    """
    scale = float(rng.triangular(
        _INTERSECTION_SCALE_LOW,
        _INTERSECTION_SCALE_MODE,
        _INTERSECTION_SCALE_HIGH,
    ))
    directional = rng.uniform(
        _DIRECTIONAL_VAR_LOW, _DIRECTIONAL_VAR_HIGH, size=N_VEHICLE_CHANNELS,
    )
    return (scale * directional).astype(np.float64)


# ── Per-day labels (PRD T06) ─────────────────────────────────────────────────

# Mirrors `server.webster.SATURATION_FLOW`. Duplicated as a module-local
# constant so this generator stays import-free of the DB-backed webster module
# (sqlalchemy / models). Update both together if the calibrated saturation
# flow changes.
SATURATION_FLOW_PCU_HR = 1400

# Six warrants the multi-task head predicts: 4 MUTCD + 2 Tagum-local.
WARRANT_NAMES_ALL: tuple[str, ...] = (
    "w1", "w2", "w3", "w4", "w_local_2", "w_local_3",
)

# Ground-truth TOD chunks used in place of K-means-discovered chunks for
# synthetic label generation. On parameter-realistic synthetic data, K-means
# converges back to these regime boundaries; using them directly avoids
# coupling label generation to a clustering step that is still in flight
# (parent plan Phase 2).
_TOD_CHUNK_NAMES: tuple[str, ...] = ("AM_RUSH", "MIDDAY", "PM_RUSH", "OFF_PEAK")
_CHUNK_SLOT_INDICES: Mapping[str, tuple[int, ...]] = {
    name: tuple(s for s in range(N_SLOTS) if regime_for_slot(s) == name)
    for name in _TOD_CHUNK_NAMES
}


def _chunk_vehicle_total(flow_matrix: np.ndarray, slot_indices: tuple[int, ...]) -> float:
    """Sum vehicle-channel slot values across a chunk.

    Used as a linear measure for W-Local 2's concentration ratio; the slot-rate
    units cancel out in the top-2 / total quotient.
    """
    if not slot_indices:
        return 0.0
    return float(flow_matrix[:N_VEHICLE_CHANNELS, list(slot_indices)].sum())


def _chunk_avg_pcu_per_approach(
    flow_matrix: np.ndarray, slot_indices: tuple[int, ...]
) -> float:
    """Average PCU/hr per approach over a chunk.

    Each slot value is already an hourly rate, so the mean across the chunk's
    (approach, slot) pairs equals the avg-PCU/hr per approach that W-Local 3
    expects.
    """
    if not slot_indices:
        return 0.0
    return float(flow_matrix[:N_VEHICLE_CHANNELS, list(slot_indices)].mean())


def evaluate_w_local_2_synthetic(
    flow_matrix: np.ndarray,
    threshold: float = DEFAULT_W_LOCAL_2_THRESHOLD,
) -> tuple[bool, float]:
    """W-Local 2 (peak concentration) on a synthetic (5, 96) flow matrix.

    Wraps the DB-free `_compute_w_local_2` helper from `server.local_warrants`
    with chunk totals derived from the ground-truth TOD chunks.
    """
    chunk_totals = [
        _chunk_vehicle_total(flow_matrix, slots)
        for slots in _CHUNK_SLOT_INDICES.values()
    ]
    return _compute_w_local_2(chunk_totals, threshold)


def evaluate_w_local_3_synthetic(
    flow_matrix: np.ndarray,
    min_pcu: float = DEFAULT_W_LOCAL_3_MIN_PCU,
) -> tuple[bool, float]:
    """W-Local 3 (lights off) on a synthetic (5, 96) flow matrix.

    Wraps the DB-free `_compute_w_local_3` helper. The third return value of
    that helper (the per-chunk signal_off list) is dropped here; only `met`
    and `confidence` participate in the multi-task warrant head's labels.
    """
    items = [
        (name, _chunk_avg_pcu_per_approach(flow_matrix, slots))
        for name, slots in _CHUNK_SLOT_INDICES.items()
    ]
    met, conf, _signal_off = _compute_w_local_3(items, min_pcu)
    return met, conf


def critical_vc_for_day(flow_matrix: np.ndarray) -> float:
    """Webster's critical flow ratio Y at the worst-loaded TOD chunk.

    Independent-phase plan with one phase per directional approach:
        Y_chunk = Σ (avg-PCU/hr per approach in chunk) / SATURATION_FLOW
    Returns the max Y across the four TOD chunks. Values > 0.90 trigger the
    `road_widening` precedence in `assign_intervention_label`.
    """
    y_max = 0.0
    for slot_indices in _CHUNK_SLOT_INDICES.values():
        if not slot_indices:
            continue
        chunk = flow_matrix[:N_VEHICLE_CHANNELS, list(slot_indices)]
        per_approach_avg = chunk.mean(axis=1)
        y = float(per_approach_avg.sum() / SATURATION_FLOW_PCU_HR)
        if y > y_max:
            y_max = y
    return y_max


def evaluate_all_warrants(
    flow_matrix: np.ndarray,
    meta: IntersectionMeta,
) -> dict[str, tuple[bool, float]]:
    """Return all 6 warrant labels {name: (met, confidence)} for one sample."""
    results: dict[str, tuple[bool, float]] = dict(evaluate_all_mutcd(flow_matrix, meta))
    results["w_local_2"] = evaluate_w_local_2_synthetic(flow_matrix)
    results["w_local_3"] = evaluate_w_local_3_synthetic(flow_matrix)
    return results


@dataclass(frozen=True)
class LabeledSample:
    """One (intersection × day) sample with the full multi-task label set.

    Attributes
    ----------
    flow_matrix : np.ndarray
        Shape ``(5, 96)``, channels-first; the CNN input.
    meta : IntersectionMeta
        Sampled intersection metadata; the CNN's late-fusion side input.
    is_weekend : bool
        Day-type marker (the flow_matrix already reflects the schedule).
    warrants : dict[str, tuple[bool, float]]
        Six entries keyed by `WARRANT_NAMES_ALL`, each (met, confidence).
    critical_vc : float
        Webster's max-chunk critical flow ratio for the day.
    intervention : str
        One of `INTERVENTION_CLASSES` ("signalize" / "road_widening" /
        "timing_only") from `assign_intervention_label`.
    """
    flow_matrix: np.ndarray
    meta: IntersectionMeta
    is_weekend: bool
    warrants: dict[str, tuple[bool, float]]
    critical_vc: float
    intervention: str


def generate_labeled_sample(
    rng: np.random.Generator,
    meta: IntersectionMeta | None = None,
    is_weekend: bool = False,
    intersection_modifier: np.ndarray | None = None,
) -> LabeledSample:
    """Draw one fully-labeled (intersection × day) sample.

    Samples missing metadata and per-intersection modifier from the
    Tagum-realistic priors when not supplied, then runs the rule pipeline:
    MUTCD W1–W4 + W-Local 2/3 → critical v/c → intervention precedence.
    """
    if meta is None:
        meta = sample_intersection_meta(rng)
    if intersection_modifier is None:
        intersection_modifier = sample_intersection_modifier(rng)

    flow_matrix = generate_day_flow_matrix(
        rng, is_weekend=is_weekend, intersection_modifier=intersection_modifier,
    )
    warrants = evaluate_all_warrants(flow_matrix, meta)
    critical_vc = critical_vc_for_day(flow_matrix)
    intervention = assign_intervention_label(
        critical_vc=critical_vc,
        is_signalized=meta.is_signalized,
        warrant_results=warrants,
    )
    return LabeledSample(
        flow_matrix=flow_matrix,
        meta=meta,
        is_weekend=is_weekend,
        warrants=warrants,
        critical_vc=critical_vc,
        intervention=intervention,
    )
