from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from common.database import get_db
from common.models import Intersection, TodChunk, User
from server.tod import (
    get_active_chunk,
    hhmm_to_minutes,
    minutes_to_hhmm,
    validate_chunks,
)
from server.utils import get_current_user, log_and_commit

router = APIRouter(prefix="/intersections", tags=["TOD"])


class TodChunkResponse(BaseModel):
    id: int
    intersection_id: int
    name: str
    start_time: str
    end_time: str


class TodChunkUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    start_time: str
    end_time: str

    @field_validator("start_time", "end_time")
    @classmethod
    def _valid_hhmm(cls, v: str) -> str:
        try:
            m = hhmm_to_minutes(v)
        except (ValueError, TypeError):
            raise ValueError(f"Invalid time format {v!r} - use HH:MM")
        if not (0 <= m <= 1440):
            raise ValueError("Time must be between 00:00 and 24:00")
        return v


def _to_resp(c: TodChunk) -> TodChunkResponse:
    return TodChunkResponse(
        id=c.id,
        intersection_id=c.intersection_id,
        name=c.name,
        start_time=minutes_to_hhmm(c.start_minutes),
        end_time=minutes_to_hhmm(c.end_minutes),
    )


@router.get("/{intersection_id}/tod-chunks", response_model=list[TodChunkResponse])
def list_tod_chunks(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[TodChunkResponse]:
    if not db.get(Intersection, intersection_id):
        raise HTTPException(status_code=404, detail="Intersection not found")
    chunks = (
        db.query(TodChunk)
        .filter_by(intersection_id=intersection_id)
        .order_by(TodChunk.start_minutes)
        .all()
    )
    return [_to_resp(c) for c in chunks]


@router.put("/{intersection_id}/tod-chunks/{chunk_id}", response_model=list[TodChunkResponse])
def update_tod_chunk(
    intersection_id: int,
    chunk_id: int,
    body: TodChunkUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[TodChunkResponse]:
    if not db.get(Intersection, intersection_id):
        raise HTTPException(status_code=404, detail="Intersection not found")

    chunk = db.get(TodChunk, chunk_id)
    if not chunk or chunk.intersection_id != intersection_id:
        raise HTTPException(status_code=404, detail="Chunk not found")

    chunk.name = body.name
    chunk.start_minutes = hhmm_to_minutes(body.start_time)
    chunk.end_minutes = hhmm_to_minutes(body.end_time)

    all_chunks = (
        db.query(TodChunk)
        .filter_by(intersection_id=intersection_id)
        .all()
    )
    validate_chunks(all_chunks)

    log_and_commit(
        f"User {user.username} updated TOD chunk '{body.name}' "
        f"({body.start_time}–{body.end_time}) for intersection {intersection_id}",
        db,
    )

    chunks = (
        db.query(TodChunk)
        .filter_by(intersection_id=intersection_id)
        .order_by(TodChunk.start_minutes)
        .all()
    )
    return [_to_resp(c) for c in chunks]


@router.get("/{intersection_id}/tod-chunks/active", response_model=TodChunkResponse | None)
def active_tod_chunk(
    intersection_id: int,
    ts: Annotated[datetime, Query(description="ISO-8601 timestamp")],
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> TodChunkResponse | None:
    if not db.get(Intersection, intersection_id):
        raise HTTPException(status_code=404, detail="Intersection not found")
    chunk = get_active_chunk(db, intersection_id, ts)
    return _to_resp(chunk) if chunk else None
