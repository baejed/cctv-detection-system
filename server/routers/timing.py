from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import Annotated, Optional
from pydantic import BaseModel

from common.database import get_db
from common import models
from server.utils import get_current_user

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

    class Config:
        from_attributes = True


def _row_to_response(row: models.TimingRecommendation) -> dict:
    return {
        "id":               row.id,
        "intersection_id":  row.intersection_id,
        "recommendation_id": row.recommendation_id,
        "chunk_name":       row.chunk_name,
        "cycle_length":     row.cycle_length,
        "green_splits":     row.green_splits,
        "effective_date":   row.effective_date.isoformat(),
        "pce_tier_used":    row.pce_tier_used,
        "signal_off":       bool(row.signal_off),
        "generated_at":     row.generated_at.isoformat(),
    }


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

    # Latest recommendation for this intersection
    latest_rec = db.execute(text("""
        SELECT id FROM recommendations
         WHERE intersection_id = :iid
         ORDER BY generated_at DESC
         LIMIT 1
    """), {"iid": intersection_id}).fetchone()

    if not latest_rec:
        return []

    rows = (
        db.query(models.TimingRecommendation)
        .filter_by(recommendation_id=latest_rec.id)
        .order_by(models.TimingRecommendation.chunk_name)
        .all()
    )
    return [_row_to_response(r) for r in rows]
