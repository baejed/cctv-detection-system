"""Webster's formula engine for 2-phase signal timing.

Webster's optimal cycle:
  L      = n_phases × (lost_time_per_phase + all_red_clearance)
  y_i    = max(q in phase_i) / S   (critical flow ratio per phase)
  Y      = Σ y_i
  C_opt  = (1.5L + 5) / (1 - Y)   clamped to [min_cycle, max_cycle]

Green splits (proportional to critical flow ratio):
  effective_green = C_opt - L
  g_i = effective_green × (y_i / Y)

Opposing approaches (NB+SB, EB+WB) share a phase and run concurrently,
so both streets in a phase receive the same green time as the critical
(higher-flow) approach in that phase.  Unrecognised directions fall back
to one phase per street (graceful degradation).

Arrival model justification (Tagum City context):
  Webster's formula assumes Poisson (random) vehicle arrivals, which holds
  when vehicles arrive independently of each other. This assumption is valid
  here because Tagum City jeepneys operate without fixed routes or scheduled
  headways — they circulate freely, making their arrivals statistically
  independent. This differs from fixed-route bus corridors (e.g. EDSA BBSS)
  where scheduled headways produce platoon arrivals that violate the Poisson
  assumption and require a platoon correction factor (HCM Chapter 19, Eq.
  19-12). No such correction is needed for this deployment.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session
from sqlalchemy import text

from common.models import Intersection, TimingRecommendation, TodChunk
from server.pce import resolve_pce

# Typical saturation flow for Philippine mixed-traffic single-lane approaches.
# HCM ideal (US) is 1900; local conditions (tricycles, pedicabs, narrow lanes,
# no strict lane discipline) reduce this to ~1400 PCU/hr.
SATURATION_FLOW = 1400  # PCU/hr per approach


_OPPOSING: dict[str, str] = {
    "northbound": "southbound",
    "southbound": "northbound",
    "eastbound":  "westbound",
    "westbound":  "eastbound",
}


def get_street_directions(db: Session, intersection_id: int) -> dict[int, str]:
    """Return {street_id: arm_direction} for every street at this intersection."""
    rows = db.execute(text("""
        SELECT id, COALESCE(arm_direction, 'unknown') AS direction
          FROM streets
         WHERE intersection_id = :iid
    """), {"iid": intersection_id}).fetchall()
    return {row.id: (row.direction or "unknown") for row in rows}


def group_phases(
    flows: dict[int, float],
    directions: dict[int, str],
) -> list[list[int]]:
    """Group street IDs into signal phases by opposing-direction pairs.

    Known N+S and E+W street pairs form 2 phases; streets with unrecognised
    or duplicate directions each get their own phase (safe fallback).
    """
    by_dir: dict[str, list[int]] = {}
    for sid in flows:
        d = directions.get(sid, "unknown")
        by_dir.setdefault(d, []).append(sid)

    seen: set[str] = set()
    phases: list[list[int]] = []
    for direction, sids in by_dir.items():
        if direction in seen:
            continue
        opp = _OPPOSING.get(direction)
        if opp and opp in by_dir:
            phases.append(sids + by_dir[opp])
            seen.add(direction)
            seen.add(opp)
        else:
            phases.append(sids)
            seen.add(direction)

    return phases or [[sid] for sid in flows]


def pcu_flow_per_street(
    db: Session,
    intersection_id: int,
    chunk: TodChunk,
    pce_map: dict[str, dict],
    lookback_days: int = 7,
) -> dict[int, float]:
    """Return average PCU/hr per street for the given TOD chunk window over recent data."""
    since = datetime.now(tz=timezone.utc) - timedelta(days=lookback_days)

    rows = db.execute(text("""
        SELECT street_id,
               object_type,
               SUM(count)::int                                           AS total_count,
               COUNT(DISTINCT DATE_TRUNC('hour', window_start))::int     AS distinct_hours
          FROM aggregation_summaries
         WHERE intersection_id = :iid
           AND street_id IS NOT NULL
           AND direction IN ('inbound', 'unknown')
           AND window_start   >= :since
           AND object_type NOT IN ('pedestrian', 'person')
           AND (  EXTRACT(HOUR   FROM window_start) * 60
                + EXTRACT(MINUTE FROM window_start))::int >= :start_min
           AND (  EXTRACT(HOUR   FROM window_start) * 60
                + EXTRACT(MINUTE FROM window_start))::int <  :end_min
         GROUP BY street_id, object_type
    """), {
        "iid":       intersection_id,
        "since":     since,
        "start_min": chunk.start_minutes,
        "end_min":   chunk.end_minutes,
    }).fetchall()

    street_pcu:   dict[int, float] = {}
    street_hours: dict[int, int]   = {}

    for row in rows:
        pce = pce_map.get(row.object_type, {}).get("pce", 1.0)
        sid = row.street_id
        street_pcu[sid]   = street_pcu.get(sid, 0.0) + row.total_count * pce
        street_hours[sid] = max(street_hours.get(sid, 0), row.distinct_hours)

    result: dict[int, float] = {}
    for sid, total_pcu in street_pcu.items():
        hours = max(street_hours[sid], 1)
        result[sid] = total_pcu / hours

    return result


def compute_timing(
    flows: dict[int, float],
    phases: list[list[int]] | None = None,
    lost_time_per_phase: int = 4,
    all_red_clearance: int = 3,
    min_cycle: int = 40,
    max_cycle: int = 120,
    crossing_width_m: float = 12.0,
) -> tuple[int, dict[int, float]]:
    """Return (cycle_length_s, {street_id: green_seconds}) using Webster's formula.

    `phases` groups streets that run concurrently (e.g. NB+SB together).
    The critical flow ratio for each phase is the highest-flow street in
    that phase.  Streets in the same phase all receive the same green time.
    Omit `phases` to fall back to one independent phase per street.
    """
    if not flows:
        return min_cycle, {}

    if phases is None:
        phases = [[sid] for sid in flows]

    n_phases = len(phases)
    L = n_phases * (lost_time_per_phase + all_red_clearance)

    # Critical flow ratio = dominant approach in each phase
    y_phases = [
        max((flows.get(sid, 0.0) for sid in ph), default=0.0) / SATURATION_FLOW
        for ph in phases
    ]
    Y = sum(y_phases)

    if Y <= 0:
        C = min_cycle
    elif Y >= 0.9:
        C = max_cycle
    else:
        C_opt = (1.5 * L + 5) / (1 - Y)
        C = int(round(max(min_cycle, min(max_cycle, C_opt))))

    G = max(0.0, C - L)
    if Y > 0:
        g_phases = [round(G * (yi / Y), 1) for yi in y_phases]
    else:
        g_each = round(G / n_phases, 1)
        g_phases = [g_each] * n_phases

    # Pedestrian minimum green: DPWH crossing time = width / 1.2 m/s + 7 s clearance.
    # Ensures every phase is long enough for a pedestrian to cross the approach road.
    ped_min_g = crossing_width_m / 1.2 + 7.0
    g_phases = [max(g, ped_min_g) for g in g_phases]

    # Recompute cycle with pedestrian-constrained splits (may exceed Webster's C_opt)
    C = max(min_cycle, min(max_cycle, int(round(L + sum(g_phases)))))

    # Streets sharing a phase all get the same green time
    splits: dict[int, float] = {}
    for ph, g in zip(phases, g_phases):
        for sid in ph:
            splits[sid] = g

    return C, splits


def _dominant_pce_tier(pce_map: dict[str, dict]) -> str:
    tiers = [v["tier"] for v in pce_map.values()]
    if "override" in tiers:
        return "override"
    if "calibrated" in tiers:
        return "calibrated"
    return "default"


def generate_timing_for_recommendation(
    db: Session,
    intersection: Intersection,
    recommendation_id: int,
    signal_off_chunks: set[str] | None = None,
) -> tuple[list[TimingRecommendation], str | None]:
    """Compute per-chunk + overall timing; return (unsaved rows, peak_chunk_name)."""
    pce_map   = resolve_pce(db, intersection.id)
    pce_tier  = _dominant_pce_tier(pce_map)
    directions = get_street_directions(db, intersection.id)

    lost_time      = intersection.lost_time_per_phase or 4
    all_red        = intersection.all_red_clearance   or 3
    min_c          = intersection.min_cycle_length    or 40
    max_c          = intersection.max_cycle_length    or 120
    crossing_width = getattr(intersection, "crossing_width_m", 12.0) or 12.0

    chunks = (
        db.query(TodChunk)
        .filter_by(intersection_id=intersection.id)
        .order_by(TodChunk.start_minutes)
        .all()
    )

    effective_date    = datetime.now(tz=timezone.utc)
    off_chunks        = signal_off_chunks or set()
    chunk_results: list[TimingRecommendation] = []
    peak_chunk_name   = None
    peak_total_flow   = -1.0

    for chunk in chunks:
        flows = pcu_flow_per_street(db, intersection.id, chunk, pce_map)

        if flows:
            phases = group_phases(flows, directions)
            cycle, splits = compute_timing(flows, phases, lost_time, all_red, min_c, max_c, crossing_width)
            total_flow = sum(flows.values())
            if total_flow > peak_total_flow:
                peak_total_flow = total_flow
                peak_chunk_name = chunk.name
        else:
            cycle  = min_c
            splits = {}

        chunk_results.append(TimingRecommendation(
            intersection_id=intersection.id,
            recommendation_id=recommendation_id,
            chunk_name=chunk.name,
            cycle_length=cycle,
            green_splits={str(k): v for k, v in splits.items()},
            effective_date=effective_date,
            pce_tier_used=pce_tier,
            signal_off=chunk.name in off_chunks,
        ))

    # Overall row mirrors the peak-flow chunk (or falls back to min_cycle)
    if peak_chunk_name:
        peak = next(r for r in chunk_results if r.chunk_name == peak_chunk_name)
        overall_cycle  = peak.cycle_length
        overall_splits = peak.green_splits
    else:
        overall_cycle  = min_c
        overall_splits = {}

    chunk_results.append(TimingRecommendation(
        intersection_id=intersection.id,
        recommendation_id=recommendation_id,
        chunk_name="overall",
        cycle_length=overall_cycle,
        green_splits=overall_splits,
        effective_date=effective_date,
        pce_tier_used=pce_tier,
        signal_off=False,
    ))

    return chunk_results, peak_chunk_name
