"""Analytical delay simulation: Webster's uniform delay + HCM gap-acceptance baseline.

Before-state by signal_status:
  fixed_time / actuated  →  Webster's uniform delay using existing timing
  unsignalized           →  HCM gap-acceptance average delay (TWSC)

After-state (all types):
  Webster's uniform delay using proposed timing from timing_recommendations rows
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from common.models import Intersection, SimulationResult, TodChunk, TimingRecommendation
from server.webster import pcu_flow_per_street, SATURATION_FLOW

_TC = 6.5   # critical gap (s), TWSC through movement HCM 6th ed.
_TF = 3.3   # follow-up time (s)
_N_MINUTES = 60


def compute_uniform_delay(C: int, g: float, q_pcu_hr: float) -> float:
    """Webster's uniform delay per vehicle (seconds).

    d = C(1 - λ)² / (2(1 - x))
    λ = g/C,  x = q·C / (s·g)  (degree of saturation, capped at 0.98)
    """
    if q_pcu_hr <= 0 or g <= 0 or C <= 0:
        return 0.0
    lam = g / C
    x = min(q_pcu_hr * C / (SATURATION_FLOW * g), 0.98)
    return round(max(0.0, C * (1 - lam) ** 2 / (2 * (1 - x))), 2)


def compute_hcm_gap_delay(q_major_pcu_hr: float, q_minor_pcu_hr: float) -> float:
    """HCM 6th Edition control delay (s/veh) for a TWSC minor-street approach."""
    if q_major_pcu_hr <= 0:
        return 5.0
    q_s = q_major_pcu_hr / 3600
    try:
        c_p = q_major_pcu_hr * math.exp(-q_s * _TC) / (1 - math.exp(-q_s * _TF))
    except (ZeroDivisionError, OverflowError):
        return 5.0
    if c_p <= 0:
        return 3600.0
    v_c = min(q_minor_pcu_hr / c_p, 0.98)
    T = 0.25  # 15-min analysis period (hours)
    d = 3600 / c_p + 900 * T * (
        (v_c - 1) + math.sqrt(max(0.0, (v_c - 1) ** 2 + v_c / (450 * T * c_p)))
    )
    return round(max(5.0, d), 2)


def _gap_acceptance_capacity(q_major_pcu_hr: float) -> float:
    """Potential capacity of a minor TWSC approach given major-street flow."""
    if q_major_pcu_hr <= 0:
        return SATURATION_FLOW
    q_s = q_major_pcu_hr / 3600
    try:
        c_p = q_major_pcu_hr * math.exp(-q_s * _TC) / (1 - math.exp(-q_s * _TF))
        return max(1.0, c_p)
    except (ZeroDivisionError, OverflowError):
        return 1.0


def _queue_series_signalized(
    q_pcu_hr: float, C: int, g: float, n_minutes: int = _N_MINUTES
) -> list[float]:
    """Queue length (vehicles) at each minute boundary for a signalized approach."""
    arrival = q_pcu_hr / 3600
    departure = SATURATION_FLOW / 3600
    red_time = C - g
    queue = 0.0
    series: list[float] = []
    for t in range(n_minutes * 60):
        phase = t % C
        if phase < red_time:
            queue += arrival
        else:
            queue = max(0.0, queue + arrival - departure)
        if t % 60 == 59:
            series.append(round(queue, 1))
    return series


def _queue_series_unsignalized(
    q_pcu_hr: float, capacity_pcu_hr: float, n_minutes: int = _N_MINUTES
) -> list[float]:
    """Queue length (vehicles) at each minute boundary for an uncontrolled approach."""
    arrival = q_pcu_hr / 3600
    service = max(capacity_pcu_hr / 3600, arrival + 1e-9)
    queue = 0.0
    series: list[float] = []
    for t in range(n_minutes * 60):
        queue = max(0.0, queue + arrival - service)
        if t % 60 == 59:
            series.append(round(queue, 1))
    return series


def generate_simulation(
    db: Session,
    intersection: Intersection,
    recommendation_id: int,
    timing_rows: list[TimingRecommendation],
) -> list[SimulationResult]:
    """Compute before/after delay per TOD chunk; return unsaved SimulationResult rows."""
    from server.pce import resolve_pce

    pce_map = resolve_pce(db, intersection.id)

    chunks = (
        db.query(TodChunk)
        .filter_by(intersection_id=intersection.id)
        .order_by(TodChunk.start_minutes)
        .all()
    )

    timing_by_chunk = {t.chunk_name: t for t in timing_rows if t.chunk_name != "overall"}
    status = intersection.signal_status or "unsignalized"
    results: list[SimulationResult] = []

    for chunk in chunks:
        timing = timing_by_chunk.get(chunk.name)
        if timing is None:
            continue

        flows = pcu_flow_per_street(db, intersection.id, chunk, pce_map)
        if not flows:
            continue

        n = len(flows)
        proposed_C = timing.cycle_length
        proposed_splits = {int(k): v for k, v in (timing.green_splits or {}).items()}

        # ── After: proposed Webster's timing ────────────────────────────
        delay_after_per: dict[int, float] = {}
        q_series_after:  dict[str, list[float]] = {}

        for sid, q in flows.items():
            g = proposed_splits.get(sid, proposed_C / n)
            delay_after_per[sid] = compute_uniform_delay(proposed_C, g, q)
            q_series_after[str(sid)] = _queue_series_signalized(q, proposed_C, g)

        # ── Before: existing timing or gap-acceptance ────────────────────
        delay_before_per: dict[int, float] = {}
        q_series_before:  dict[str, list[float]] = {}

        if status in ("fixed_time", "actuated"):
            exist_C = intersection.existing_cycle_length or proposed_C
            raw_splits = intersection.existing_green_splits or {}
            exist_splits = (
                {int(k): v for k, v in raw_splits.items()}
                if raw_splits
                else {sid: exist_C / n for sid in flows}
            )
            for sid, q in flows.items():
                g = exist_splits.get(sid, exist_C / n)
                delay_before_per[sid] = compute_uniform_delay(exist_C, g, q)
                q_series_before[str(sid)] = _queue_series_signalized(q, exist_C, g)
        else:
            # unsignalized: major-street approach has near-zero delay
            major_id = max(flows, key=flows.__getitem__)
            q_major = flows[major_id]
            for sid, q in flows.items():
                if sid == major_id:
                    delay_before_per[sid] = 2.0
                    cap = SATURATION_FLOW
                else:
                    delay_before_per[sid] = compute_hcm_gap_delay(q_major, q)
                    cap = _gap_acceptance_capacity(q_major)
                q_series_before[str(sid)] = _queue_series_unsignalized(q, cap)

        # ── Weighted averages ────────────────────────────────────────────
        total_flow = sum(flows.values())
        if total_flow > 0:
            delay_before = sum(delay_before_per[sid] * flows[sid] for sid in flows) / total_flow
            delay_after  = sum(delay_after_per[sid]  * flows[sid] for sid in flows) / total_flow
        else:
            delay_before = delay_after = 0.0

        chunk_hours = (chunk.end_minutes - chunk.start_minutes) / 60.0
        vh_saved = (delay_before - delay_after) * total_flow * chunk_hours / 3600

        results.append(SimulationResult(
            intersection_id=intersection.id,
            recommendation_id=recommendation_id,
            chunk_name=chunk.name,
            delay_before=round(delay_before, 2),
            delay_after=round(delay_after, 2),
            volume_pcu_hr=round(total_flow, 2),
            vehicle_hours_saved=round(vh_saved, 3),
            queue_series_before=q_series_before,
            queue_series_after=q_series_after,
        ))

    return results
