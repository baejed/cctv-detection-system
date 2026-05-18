from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from common.database import get_db
from common.models import Intersection, PceOverride, User
from server.pce import DPWH_DEFAULTS, calibrate_pce, resolve_pce
from server.utils import get_current_user, log_and_commit

router = APIRouter(prefix="/intersections", tags=["PCE"])


class PceOverrideCreate(BaseModel):
    vehicle_type: str
    pce_value: float = Field(gt=0)


class PceValueResponse(BaseModel):
    vehicle_type: str
    pce: float
    tier: str   # "default" | "calibrated" | "override"


class PceResolvedResponse(BaseModel):
    intersection_id: int
    values: list[PceValueResponse]


@router.get("/{intersection_id}/pce", response_model=PceResolvedResponse)
def get_pce(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> PceResolvedResponse:
    if not db.get(Intersection, intersection_id):
        raise HTTPException(status_code=404, detail="Intersection not found")

    resolved = resolve_pce(db, intersection_id)
    values = [
        PceValueResponse(vehicle_type=vt, pce=info["pce"], tier=info["tier"])
        for vt, info in sorted(resolved.items())
    ]
    return PceResolvedResponse(intersection_id=intersection_id, values=values)


@router.post("/{intersection_id}/pce/overrides", response_model=PceResolvedResponse)
def set_pce_override(
    intersection_id: int,
    body: PceOverrideCreate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> PceResolvedResponse:
    if not db.get(Intersection, intersection_id):
        raise HTTPException(status_code=404, detail="Intersection not found")

    existing = (
        db.query(PceOverride)
        .filter_by(intersection_id=intersection_id, vehicle_type=body.vehicle_type)
        .first()
    )
    if existing:
        existing.pce_value = body.pce_value
    else:
        db.add(PceOverride(
            intersection_id=intersection_id,
            vehicle_type=body.vehicle_type,
            pce_value=body.pce_value,
        ))

    log_and_commit(
        f"User {user.username} set PCE override for intersection {intersection_id}: "
        f"{body.vehicle_type}={body.pce_value}",
        db,
    )

    resolved = resolve_pce(db, intersection_id)
    values = [
        PceValueResponse(vehicle_type=vt, pce=info["pce"], tier=info["tier"])
        for vt, info in sorted(resolved.items())
    ]
    return PceResolvedResponse(intersection_id=intersection_id, values=values)


@router.delete("/{intersection_id}/pce/overrides/{vehicle_type}", response_model=PceResolvedResponse)
def delete_pce_override(
    intersection_id: int,
    vehicle_type: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> PceResolvedResponse:
    if not db.get(Intersection, intersection_id):
        raise HTTPException(status_code=404, detail="Intersection not found")

    override = (
        db.query(PceOverride)
        .filter_by(intersection_id=intersection_id, vehicle_type=vehicle_type)
        .first()
    )
    if not override:
        raise HTTPException(status_code=404, detail="Override not found")

    db.delete(override)
    log_and_commit(
        f"User {user.username} removed PCE override for intersection {intersection_id}: {vehicle_type}",
        db,
    )

    resolved = resolve_pce(db, intersection_id)
    values = [
        PceValueResponse(vehicle_type=vt, pce=info["pce"], tier=info["tier"])
        for vt, info in sorted(resolved.items())
    ]
    return PceResolvedResponse(intersection_id=intersection_id, values=values)


@router.post("/{intersection_id}/pce/calibrate", response_model=PceResolvedResponse)
def trigger_calibration(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> PceResolvedResponse:
    if not db.get(Intersection, intersection_id):
        raise HTTPException(status_code=404, detail="Intersection not found")

    calibrate_pce(db, intersection_id)

    resolved = resolve_pce(db, intersection_id)
    values = [
        PceValueResponse(vehicle_type=vt, pce=info["pce"], tier=info["tier"])
        for vt, info in sorted(resolved.items())
    ]
    return PceResolvedResponse(intersection_id=intersection_id, values=values)
