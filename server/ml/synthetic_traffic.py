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

Per-sample warrant and intervention labels are added in T06 (next task);
this module only emits raw flow matrices + metadata.
"""
from __future__ import annotations

from typing import Mapping

import numpy as np

from server.warrant_rules import IntersectionMeta


N_SLOTS = 96
N_VEHICLE_CHANNELS = 4
PED_CHANNEL_INDEX = 4
N_CHANNELS = N_VEHICLE_CHANNELS + 1  # 5 = 4 approaches + pedestrians


# ── Vehicle regimes (parent-plan Phase 1) ────────────────────────────────────

# PCU/hr per (NB, SB, EB, WB). Peak/off-peak ratio ~9–10× tracks published
# Philippine urban AADT distributions; directional asymmetry reflects typical
# AM-inbound / PM-outbound commute patterns.
GROUND_TRUTH_REGIMES: Mapping[str, tuple[int, int, int, int]] = {
    "AM_RUSH":  (850, 250, 700, 300),
    "MIDDAY":   (420, 380, 410, 390),
    "PM_RUSH":  (250, 850, 300, 700),
    "OFF_PEAK": (90,  80,  85,  75),
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
PED_PROFILES: Mapping[str, int] = {
    "AM_PED":     140,
    "LUNCH":       90,
    "PM_PED":     150,
    "DAY_LOW":     35,
    "NIGHT_LOW":   10,
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


def sample_intersection_modifier(rng: np.random.Generator) -> np.ndarray:
    """Per-approach multiplier in [0.8, 1.2] for per-intersection variation.

    Matches parent-plan Phase 1 Task 2 Step 2. Returned as a length-4 float
    array so it slots directly into `generate_day_flow_matrix`.
    """
    return rng.uniform(0.8, 1.2, size=N_VEHICLE_CHANNELS).astype(np.float64)
