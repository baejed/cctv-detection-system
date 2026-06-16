from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import Annotated, Optional
from pydantic import BaseModel, ConfigDict

from common.database import get_db
from common import models
from server.utils import get_current_user
from server.webster import pcu_flow_per_street, SATURATION_FLOW
from server.pce import resolve_pce

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


def _row_to_response(
    row: models.TimingRecommendation,
    measured_flows: dict | None = None,
    assumptions: dict | None = None,
) -> dict:
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
        "measured_flows":   measured_flows,
        "assumptions":      assumptions,
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

    pce_map = resolve_pce(db, intersection_id)
    chunks_by_name = {
        c.name: c
        for c in db.query(models.TodChunk).filter_by(intersection_id=intersection_id).all()
    }
    pce_tier = rows[0].pce_tier_used if rows else "default"
    assumptions = {
        "saturation_flow_pcu_hr": SATURATION_FLOW,
        "lost_time_per_phase_s": intersection.lost_time_per_phase or 4,
        "all_red_clearance_s": intersection.all_red_clearance or 3,
        "min_cycle_s": intersection.min_cycle_length or 40,
        "max_cycle_s": intersection.max_cycle_length or 120,
        "pce_tier": pce_tier,
    }

    result = []
    for row in rows:
        chunk = chunks_by_name.get(row.chunk_name)
        flows: dict | None = None
        if chunk:
            raw = pcu_flow_per_street(db, intersection_id, chunk, pce_map)
            flows = {str(k): round(v, 1) for k, v in raw.items()} if raw else None
        result.append(_row_to_response(row, measured_flows=flows, assumptions=assumptions))

    return result
