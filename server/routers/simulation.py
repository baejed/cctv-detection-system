from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from common import models
from common.database import get_db
from server.utils import get_current_user
from server.simulation import delay_to_los

router = APIRouter(prefix="/simulation", tags=["Simulation"])


class SimulationChunkResponse(BaseModel):
    chunk_name: str
    delay_before: float
    delay_after: float
    los_before: str
    los_after: str
    vc_ratio_before: Optional[float] = None
    vc_ratio_after: Optional[float] = None
    volume_pcu_hr: float
    vehicle_hours_saved: float
    queue_series_before: Optional[dict] = None
    queue_series_after: Optional[dict] = None
    generated_at: str

    model_config = ConfigDict(from_attributes=True)


class DailySummaryResponse(BaseModel):
    total_vehicle_hours_saved: float
    avg_delay_before: float
    avg_delay_after: float
    los_before: str
    los_after: str
    total_volume_pcu_hr: float


class SimulationResponse(BaseModel):
    intersection_id: int
    intersection_name: str
    signal_status: str
    baseline_note: str = ""
    existing_cycle_s: Optional[int] = None
    chunks: list[SimulationChunkResponse]
    daily_summary: DailySummaryResponse


@router.get("/{intersection_id}", response_model=SimulationResponse)
def get_simulation(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Return the latest simulation results for an intersection."""
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    latest_rec = db.execute(text("""
        SELECT id FROM recommendations
         WHERE intersection_id = :iid
         ORDER BY generated_at DESC
         LIMIT 1
    """), {"iid": intersection_id}).fetchone()

    if not latest_rec:
        raise HTTPException(status_code=404, detail="No recommendations found for this intersection")

    rows = (
        db.query(models.SimulationResult)
        .filter_by(recommendation_id=latest_rec.id)
        .order_by(models.SimulationResult.chunk_name)
        .all()
    )

    if not rows:
        raise HTTPException(status_code=404, detail="No simulation results found — run generate first")

    status = intersection.signal_status or "unsignalized"
    before_signalized = status in ("fixed_time", "actuated")
    chunks = [
        SimulationChunkResponse(
            chunk_name=r.chunk_name,
            delay_before=r.delay_before,
            delay_after=r.delay_after,
            los_before=delay_to_los(r.delay_before, signalized=before_signalized),
            los_after=delay_to_los(r.delay_after, signalized=True),
            vc_ratio_before=r.vc_ratio_before,
            vc_ratio_after=r.vc_ratio_after,
            volume_pcu_hr=r.volume_pcu_hr,
            vehicle_hours_saved=r.vehicle_hours_saved,
            queue_series_before=r.queue_series_before,
            queue_series_after=r.queue_series_after,
            generated_at=r.generated_at.isoformat(),
        )
        for r in rows
    ]

    total_vh_saved = sum(c.vehicle_hours_saved for c in chunks)
    total_vol = sum(c.volume_pcu_hr for c in chunks)
    n = len(chunks)
    avg_before = sum(c.delay_before for c in chunks) / n if n else 0.0
    avg_after  = sum(c.delay_after  for c in chunks) / n if n else 0.0

    existing_cycle = intersection.existing_cycle_length
    existing_splits = intersection.existing_green_splits

    if status == "unsignalized":
        baseline_note = (
            "Before-state: HCM gap-acceptance (TWSC) — "
            "no signal present; minor approaches yield to major-street gaps"
        )
    elif status == "fixed_time":
        if existing_cycle and existing_splits:
            baseline_note = (
                f"Before-state: Fixed-time signal, {existing_cycle}s cycle · "
                f"{len(existing_splits)}-approach splits (observed or configured)"
            )
        elif existing_cycle:
            baseline_note = (
                f"Before-state: Fixed-time signal, {existing_cycle}s cycle · "
                "equal splits assumed (no per-approach data)"
            )
        else:
            baseline_note = (
                "Before-state: Fixed-time signal · "
                "cycle length and splits assumed (not configured)"
            )
    elif status == "actuated":
        baseline_note = (
            "Before-state: Actuated signal · "
            "delay estimated from average phase utilization"
        )
    else:
        baseline_note = f"Before-state: {status.replace('_', ' ')} signal"

    return SimulationResponse(
        intersection_id=intersection_id,
        intersection_name=intersection.name,
        signal_status=status,
        baseline_note=baseline_note,
        existing_cycle_s=existing_cycle,
        chunks=chunks,
        daily_summary=DailySummaryResponse(
            total_vehicle_hours_saved=round(total_vh_saved, 2),
            avg_delay_before=round(avg_before, 2),
            avg_delay_after=round(avg_after, 2),
            los_before=delay_to_los(avg_before, signalized=before_signalized),
            los_after=delay_to_los(avg_after, signalized=True),
            total_volume_pcu_hr=round(total_vol, 2),
        ),
    )
