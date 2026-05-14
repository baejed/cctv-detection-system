from server.schemas import DetectionResponse
from server.utils import log_and_commit, get_current_user
from fastapi import APIRouter, Depends, HTTPException, Query
from common.models import User, Intersection, CCTV, Detection, DetectionInRegion, Region
from common.database import get_db
from sqlalchemy.orm import Session
from typing import Annotated, Optional
from datetime import datetime


router = APIRouter(
    prefix="/detections",
    tags=["Detections"]
)


@router.get("/cctv/{cctv_id}", response_model=list[DetectionResponse])
def get_detections(
    cctv_id: int,
    db: Annotated[Session, Depends(get_db)],
    start_time: Optional[datetime] = None,
    end_time: Optional[datetime] = None,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
) -> list[DetectionResponse]:
    db_cctv = db.get(CCTV, cctv_id)

    if not db_cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")

    q = db.query(Detection).filter(Detection.cctv_id == cctv_id)

    if start_time:
        q = q.filter(Detection.time >= start_time)
    if end_time:
        q = q.filter(Detection.time <= end_time)

    return q.order_by(Detection.time.desc()).offset(offset).limit(limit).all()


@router.get("/region/{region_id}", response_model=list[DetectionResponse])
def get_region_detections(
    region_id: int,
    db: Annotated[Session, Depends(get_db)],
    start_time: Optional[datetime] = None,
    end_time: Optional[datetime] = None,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
) -> list[DetectionResponse]:
    db_region = db.get(Region, region_id)

    if not db_region:
        raise HTTPException(status_code=404, detail="Region not found")

    q = db.query(DetectionInRegion).filter(DetectionInRegion.region_id == region_id)

    if start_time:
        q = q.filter(DetectionInRegion.time >= start_time)
    if end_time:
        q = q.filter(DetectionInRegion.time <= end_time)

    return [
        row.detection
        for row in q.order_by(DetectionInRegion.time.desc()).offset(offset).limit(limit).all()
    ]