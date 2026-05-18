"""Webster's formula engine for 4-phase signal timing.

Webster's optimal cycle:
  L      = n_phases × (lost_time_per_phase + all_red_clearance)
  y_i    = q_i / S   (critical flow ratio per approach; S = saturation flow)
  Y      = Σ y_i
  C_opt  = (1.5L + 5) / (1 - Y)   clamped to [min_cycle, max_cycle]

Green splits (proportional to flow ratio):
  effective_green = C_opt - L
  g_i = effective_green × (y_i / Y)
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session
from sqlalchemy import text

from common.models import Intersection, TimingRecommendation, TodChunk
from server.pce import resolve_pce

SATURATION_FLOW = 1800  # PCU/hr per approach (single lane)


def pcu_flow_per_street(
    db: Session,
    intersection_id: int,
    chunk: TodChunk,
    pce_map: dict[str, dict],
    lookback_days: int = 7,
) -> dict[int, float]:
    """Return average PCU/hr per street for the given TOD chunk window over recent data."""
    since = datetime.now(tz=timezone.utc) - timedelta(days=lookback_days)
    chunk_hours = (chunk.end_minutes - chunk.start_minutes) / 60.0

    rows = db.execute(text("""
        SELECT street_id,
               object_type,
               SUM(count)::int                              AS total_count,
               COUNT(DISTINCT DATE(window_start))::int      AS distinct_days
          FROM aggregation_summaries
         WHERE intersection_id = :iid
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

    street_pcu:  dict[int, float] = {}
    street_days: dict[int, int]   = {}

    for row in rows:
        pce = pce_map.get(row.object_type, {}).get("pce", 1.0)
        sid = row.street_id
        street_pcu[sid]  = street_pcu.get(sid, 0.0) + row.total_count * pce
        street_days[sid] = max(street_days.get(sid, 0), row.distinct_days)

    result: dict[int, float] = {}
    for sid, total_pcu in street_pcu.items():
        days = max(street_days[sid], 1)
        result[sid] = total_pcu / (days * chunk_hours)

    return result


def compute_timing(
    flows: dict[int, float],
    lost_time_per_phase: int = 4,
    all_red_clearance: int = 3,
    min_cycle: int = 40,
    max_cycle: int = 120,
) -> tuple[int, dict[int, float]]:
    """Return (cycle_length_s, {street_id: green_seconds}) using Webster's formula."""
    n = len(flows)
    if n == 0:
        return min_cycle, {}

    L = n * (lost_time_per_phase + all_red_clearance)
    y = {sid: q / SATURATION_FLOW for sid, q in flows.items()}
    Y = sum(y.values())

    if Y <= 0:
        C = min_cycle
    elif Y >= 0.9:
        C = max_cycle
    else:
        C_opt = (1.5 * L + 5) / (1 - Y)
        C = int(round(max(min_cycle, min(max_cycle, C_opt))))

    G = max(0.0, C - L)
    if Y > 0:
        splits = {sid: round(G * (yi / Y), 1) for sid, yi in y.items()}
    else:
        g_each = round(G / n, 1)
        splits = {sid: g_each for sid in flows}

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

    lost_time = intersection.lost_time_per_phase or 4
    all_red   = intersection.all_red_clearance   or 3
    min_c     = intersection.min_cycle_length    or 40
    max_c     = intersection.max_cycle_length    or 120

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
            cycle, splits = compute_timing(flows, lost_time, all_red, min_c, max_c)
            total_flow = sum(flows.values())
            if total_flow > peak_total_flow:
                peak_total_flow   = total_flow
                peak_chunk_name   = chunk.name
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
