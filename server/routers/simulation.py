from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from common import models
from common.database import get_db
from server.utils import get_current_user

router = APIRouter(prefix="/simulation", tags=["Simulation"])


class SimulationChunkResponse(BaseModel):
    chunk_name: str
    delay_before: float
    delay_after: float
    volume_pcu_hr: float
    vehicle_hours_saved: float
    queue_series_before: Optional[dict] = None
    queue_series_after: Optional[dict] = None
    generated_at: str

    class Config:
        from_attributes = True


class DailySummaryResponse(BaseModel):
    total_vehicle_hours_saved: float
    avg_delay_before: float
    avg_delay_after: float
    total_volume_pcu_hr: float


class SimulationResponse(BaseModel):
    intersection_id: int
    intersection_name: str
    signal_status: str
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

    chunks = [
        SimulationChunkResponse(
            chunk_name=r.chunk_name,
            delay_before=r.delay_before,
            delay_after=r.delay_after,
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

    return SimulationResponse(
        intersection_id=intersection_id,
        intersection_name=intersection.name,
        signal_status=intersection.signal_status or "unsignalized",
        chunks=chunks,
        daily_summary=DailySummaryResponse(
            total_vehicle_hours_saved=round(total_vh_saved, 2),
            avg_delay_before=round(avg_before, 2),
            avg_delay_after=round(avg_after, 2),
            total_volume_pcu_hr=round(total_vol, 2),
        ),
    )
