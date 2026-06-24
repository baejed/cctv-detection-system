from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from common.database import get_db
from common.models import Intersection, User
from server.pce import (
    DPWH_DEFAULTS,
    calibrate_pce,
    delete_override,
    resolve_pce,
    set_override,
)
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


def _resolved_response(db: Session, intersection_id: int) -> PceResolvedResponse:
    """Build the public PCE view for an intersection.

    Used after every mutation so callers see the post-state in one round trip.
    """
    resolved = resolve_pce(db, intersection_id)
    values = [
        PceValueResponse(vehicle_type=vt, pce=info["pce"], tier=info["tier"])
        for vt, info in sorted(resolved.items())
    ]
    return PceResolvedResponse(intersection_id=intersection_id, values=values)


def _require_intersection(db: Session, intersection_id: int) -> None:
    if not db.get(Intersection, intersection_id):
        raise HTTPException(status_code=404, detail="Intersection not found")


@router.get("/{intersection_id}/pce", response_model=PceResolvedResponse)
def get_pce(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> PceResolvedResponse:
    _require_intersection(db, intersection_id)
    return _resolved_response(db, intersection_id)


@router.post("/{intersection_id}/pce/overrides", response_model=PceResolvedResponse)
def set_pce_override(
    intersection_id: int,
    body: PceOverrideCreate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> PceResolvedResponse:
    _require_intersection(db, intersection_id)
    set_override(db, intersection_id, body.vehicle_type, body.pce_value)
    log_and_commit(
        f"User {user.username} set PCE override for intersection {intersection_id}: "
        f"{body.vehicle_type}={body.pce_value}",
        db,
    )
    return _resolved_response(db, intersection_id)


@router.delete("/{intersection_id}/pce/overrides/{vehicle_type}", response_model=PceResolvedResponse)
def delete_pce_override(
    intersection_id: int,
    vehicle_type: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> PceResolvedResponse:
    _require_intersection(db, intersection_id)
    if not delete_override(db, intersection_id, vehicle_type):
        raise HTTPException(status_code=404, detail="Override not found")
    log_and_commit(
        f"User {user.username} removed PCE override for intersection {intersection_id}: {vehicle_type}",
        db,
    )
    return _resolved_response(db, intersection_id)


@router.post("/{intersection_id}/pce/calibrate", response_model=PceResolvedResponse)
def trigger_calibration(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> PceResolvedResponse:
    _require_intersection(db, intersection_id)
    calibrate_pce(db, intersection_id)
    return _resolved_response(db, intersection_id)


# Re-exported so external callers can read the defaults without reaching into
# server.pce directly (helps keep the seam at this module).
__all__ = ["router", "DPWH_DEFAULTS"]
