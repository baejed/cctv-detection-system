from server.schemas import RegionPointBase, RegionBase, RegionResponse
from server.utils import log_and_commit, get_current_user
from fastapi import APIRouter, Depends, HTTPException
from common.models import User, Region, RegionPoint
from common.database import get_db
from sqlalchemy.orm import Session
from typing import Annotated


router = APIRouter(
    prefix="/regions",
    tags=["Regions"]
)


@router.post("/", response_model=RegionResponse)
def create_region(
    region: RegionBase,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> RegionResponse:
    db_region = Region(cctv_id=region.cctv_id, street_id=region.street_id)

    for region_point in region.region_points:
        db_region.region_points.append(RegionPoint(x=region_point.x, y=region_point.y))

    db.add(db_region)
    db.commit()
    db.refresh(db_region)
    log_and_commit(f"User {user.username} created region for street {db_region.street.name}", db)
    return db_region


@router.get("/", response_model=list[RegionResponse])
def get_regions(
    db: Annotated[Session, Depends(get_db)],
) -> list[RegionResponse]:
    return db.query(Region).all()


@router.get("/{region_id}", response_model=RegionResponse)
def get_region(
    region_id: int,
    db: Annotated[Session, Depends(get_db)],
) -> RegionResponse:
    db_region = db.get(Region, region_id)

    if not db_region:
        raise HTTPException(status_code=404, detail="Region not found")
    
    return db_region


@router.put("/{region_id}", response_model=RegionResponse)
def update_region(
    region_id: int,
    region: RegionBase,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> RegionResponse:
    db_region = db.get(Region, region_id)

    if not db_region:
        raise HTTPException(status_code=404, detail="Region not found")

    db_region.cctv_id = region.cctv_id
    db_region.street_id = region.street_id
    db_region.direction = region.direction

    db_region.region_points.clear()
    for region_point in region.region_points:
        db_region.region_points.append(RegionPoint(x=region_point.x, y=region_point.y))

    db.commit()
    db.refresh(db_region)
    log_and_commit(f"User {user.username} updated region for street {db_region.street.name}", db)
    return db_region


@router.delete("/{region_id}")
def delete_region(
    region_id: int,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    db_region = db.get(Region, region_id)

    if not db_region:
        raise HTTPException(status_code=404, detail="Region not found")

    street_name = db_region.street.name if db_region.street else str(region_id)
    db.delete(db_region)
    log_and_commit(f"User {user.username} deleted region for street {street_name}", db)
    return {"detail": "Region deleted"}