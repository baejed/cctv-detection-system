"""Local warrant evaluation for Tagum City conditions (W-Local 1, 2, 3).

W-Local 1 — High motorcycle/pedicab ratio:
    Fired when motorcycles + pedicabs exceed a threshold (default 60%) of total
    vehicle volume in any time chunk.

W-Local 2 — Peak concentration:
    Fired when ≥70% of daily volume is concentrated in the top 1–2 time chunks.

W-Local 3 — Lights off:
    Fired when avg PCU/hr per approach falls below a minimum (default 30 PCU/hr)
    in any chunk. Those chunks are marked signal_off.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session
from sqlalchemy import text

from common.models import Intersection, TodChunk
from server.pce import resolve_pce

MOTORCYCLE_PEDICAB_TYPES = frozenset({"motorcycle", "pedicab", "tricycle"})

DEFAULT_W_LOCAL_1_THRESHOLD = 0.60
DEFAULT_W_LOCAL_2_THRESHOLD = 0.70
DEFAULT_W_LOCAL_3_MIN_PCU   = 30.0


# ── Pure computation helpers (DB-free, fully unit-testable) ──────────────────

def _compute_w_local_1(
    chunk_counts: list[dict[str, float]],
    threshold: float,
) -> tuple[bool, float]:
    """Return (met, confidence) given per-chunk vehicle-type counts and a ratio threshold."""
    max_ratio = 0.0
    for counts in chunk_counts:
        total = sum(counts.values())
        if total == 0:
            continue
        moto_ped = sum(v for t, v in counts.items() if t in MOTORCYCLE_PEDICAB_TYPES)
        ratio = moto_ped / total
        if ratio > max_ratio:
            max_ratio = ratio
    met = max_ratio >= threshold
    confidence = min(1.0, max_ratio / threshold) if threshold > 0 else 0.0
    return met, round(confidence, 4)


def _compute_w_local_2(
    chunk_totals: list[float],
    threshold: float,
) -> tuple[bool, float]:
    """Return (met, confidence) given per-chunk total vehicle counts and a concentration threshold."""
    daily_total = sum(chunk_totals)
    if daily_total == 0:
        return False, 0.0
    top2 = sum(sorted(chunk_totals, reverse=True)[:2])
    concentration = top2 / daily_total
    met = concentration >= threshold
    confidence = min(1.0, concentration / threshold) if threshold > 0 else 0.0
    return met, round(confidence, 4)


def _compute_w_local_3(
    pcu_per_approach_by_chunk: list[tuple[str, float]],
    min_pcu: float,
) -> tuple[bool, float, list[str]]:
    """Return (any_triggered, confidence, signal_off_chunk_names).

    pcu_per_approach_by_chunk: list of (chunk_name, avg_pcu_per_approach).
    Confidence measures how far below threshold the lowest chunk is.
    """
    signal_off: list[str] = []
    ratios: list[float] = []

    for chunk_name, pcu_per_approach in pcu_per_approach_by_chunk:
        ratio = pcu_per_approach / min_pcu if min_pcu > 0 else float("inf")
        ratios.append(ratio)
        if pcu_per_approach < min_pcu:
            signal_off.append(chunk_name)

    met = len(signal_off) > 0
    if not ratios:
        confidence = 0.0
    else:
        min_ratio = min(ratios)
        confidence = max(0.0, min(1.0, 1.0 - min_ratio))

    return met, round(confidence, 4), signal_off


# ── DB-backed data fetchers ──────────────────────────────────────────────────

def _chunk_vehicle_counts(
    db: Session,
    intersection_id: int,
    chunk: TodChunk,
    lookback_days: int = 7,
) -> dict[str, float]:
    """Average daily vehicle count per type for the chunk window (non-pedestrian)."""
    since = datetime.now(tz=timezone.utc) - timedelta(days=lookback_days)
    rows = db.execute(text("""
        SELECT object_type,
               SUM(count)::int                         AS total_count,
               COUNT(DISTINCT DATE(window_start))::int AS distinct_days
          FROM aggregation_summaries
         WHERE intersection_id = :iid
           AND window_start   >= :since
           AND object_type NOT IN ('pedestrian', 'person')
           AND (EXTRACT(HOUR   FROM window_start) * 60
              + EXTRACT(MINUTE FROM window_start))::int >= :start_min
           AND (EXTRACT(HOUR   FROM window_start) * 60
              + EXTRACT(MINUTE FROM window_start))::int <  :end_min
         GROUP BY object_type
    """), {
        "iid":       intersection_id,
        "since":     since,
        "start_min": chunk.start_minutes,
        "end_min":   chunk.end_minutes,
    }).fetchall()

    return {
        row.object_type: row.total_count / max(row.distinct_days, 1)
        for row in rows
    }


def _chunk_pcu_per_approach(
    db: Session,
    intersection_id: int,
    chunk: TodChunk,
    pce_map: dict[str, dict],
    lookback_days: int = 7,
) -> float:
    """Average PCU/hr per street approach for the chunk window."""
    counts = _chunk_vehicle_counts(db, intersection_id, chunk, lookback_days)
    total_pcu_raw = sum(
        count * pce_map.get(vtype, {}).get("pce", 1.0)
        for vtype, count in counts.items()
    )
    chunk_hours = (chunk.end_minutes - chunk.start_minutes) / 60.0
    total_pcu_per_hour = total_pcu_raw / max(chunk_hours, 0.01)

    n_approaches = int(
        db.execute(
            text("SELECT COUNT(*) FROM streets WHERE intersection_id = :iid"),
            {"iid": intersection_id},
        ).scalar() or 1
    )
    return total_pcu_per_hour / n_approaches


# ── Public evaluation API ────────────────────────────────────────────────────

def evaluate_w_local_1(
    db: Session,
    intersection: Intersection,
    chunks: list[TodChunk],
) -> tuple[bool, float]:
    threshold = intersection.w_local_1_threshold or DEFAULT_W_LOCAL_1_THRESHOLD
    chunk_counts = [_chunk_vehicle_counts(db, intersection.id, chunk) for chunk in chunks]
    return _compute_w_local_1(chunk_counts, threshold)


def evaluate_w_local_2(
    db: Session,
    intersection: Intersection,
    chunks: list[TodChunk],
) -> tuple[bool, float]:
    threshold = intersection.w_local_2_threshold or DEFAULT_W_LOCAL_2_THRESHOLD
    chunk_totals = [
        sum(_chunk_vehicle_counts(db, intersection.id, chunk).values())
        for chunk in chunks
    ]
    return _compute_w_local_2(chunk_totals, threshold)


def evaluate_w_local_3(
    db: Session,
    intersection: Intersection,
    chunks: list[TodChunk],
    pce_map: dict[str, dict],
) -> tuple[bool, float, list[str]]:
    min_pcu = intersection.w_local_3_min_pcu or DEFAULT_W_LOCAL_3_MIN_PCU
    pcu_list = [
        (chunk.name, _chunk_pcu_per_approach(db, intersection.id, chunk, pce_map))
        for chunk in chunks
    ]
    return _compute_w_local_3(pcu_list, min_pcu)


def evaluate_all(
    db: Session,
    intersection: Intersection,
    chunks: list[TodChunk],
) -> tuple[dict, list[str]]:
    """Run all three local warrants.

    Returns (rec_fields_dict, signal_off_chunk_names) where rec_fields_dict maps
    directly onto Recommendation model columns.
    """
    pce_map = resolve_pce(db, intersection.id)

    w1_met, w1_conf = evaluate_w_local_1(db, intersection, chunks)
    w2_met, w2_conf = evaluate_w_local_2(db, intersection, chunks)
    w3_met, w3_conf, signal_off = evaluate_w_local_3(db, intersection, chunks, pce_map)

    return {
        "w_local_1_met":        w1_met,
        "w_local_1_confidence": w1_conf,
        "w_local_2_met":        w2_met,
        "w_local_2_confidence": w2_conf,
        "w_local_3_met":        w3_met,
        "w_local_3_confidence": w3_conf,
    }, signal_off
