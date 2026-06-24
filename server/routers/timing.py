from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Annotated, Optional
from pydantic import BaseModel, ConfigDict

from common.database import get_db
from common import models
from server.utils import get_current_user
from server.webster import get_latest_timing

router = APIRouter(prefix="/timing-recommendations", tags=["Timing"])


class TimingChunkResponse(BaseModel):
    id: int
    intersection_id: int
    recommendation_id: int
    chunk_name: str
    cycle_length: int
    green_splits: dict
    effective_date: str
    pce_tier_used: str
    signal_off: bool = False
    generated_at: str
    measured_flows: Optional[dict] = None
    assumptions: Optional[dict] = None

    model_config = ConfigDict(from_attributes=True)


@router.get("/{intersection_id}", response_model=list[TimingChunkResponse])
def get_timing_recommendations(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Return the latest per-chunk timing recommendations for an intersection."""
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    rows_with_flows, assumptions = get_latest_timing(db, intersection)

    return [
        TimingChunkResponse(
            id=r.row.id,
            intersection_id=r.row.intersection_id,
            recommendation_id=r.row.recommendation_id,
            chunk_name=r.row.chunk_name,
            cycle_length=r.row.cycle_length,
            green_splits=r.row.green_splits,
            effective_date=r.row.effective_date.isoformat(),
            pce_tier_used=r.row.pce_tier_used,
            signal_off=bool(r.row.signal_off),
            generated_at=r.row.generated_at.isoformat(),
            measured_flows=r.measured_flows,
            assumptions=assumptions,
        )
        for r in rows_with_flows
    ]
