"""Time-of-day chunk utilities."""
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from common.models import TodChunk

TOD_DEFAULTS: list[tuple[str, int, int]] = [
    ("Early Morning", 0,    360),   # 00:00 – 06:00
    ("AM Peak",       360,  540),   # 06:00 – 09:00
    ("Midday",        540,  720),   # 09:00 – 12:00
    ("PM Peak",       720,  1080),  # 12:00 – 18:00
    ("Night",         1080, 1440),  # 18:00 – 24:00
]


def minutes_to_hhmm(m: int) -> str:
    if m == 1440:
        return "24:00"
    return f"{m // 60:02d}:{m % 60:02d}"


def hhmm_to_minutes(s: str) -> int:
    parts = s.strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"Invalid time format: {s!r}")
    h, m = int(parts[0]), int(parts[1])
    return h * 60 + m


def seed_tod_chunks(db: Session, intersection_id: int) -> None:
    for name, start, end in TOD_DEFAULTS:
        db.add(TodChunk(intersection_id=intersection_id, name=name,
                        start_minutes=start, end_minutes=end))


def get_active_chunk(db: Session, intersection_id: int, ts: datetime) -> TodChunk | None:
    minutes = ts.hour * 60 + ts.minute
    chunks = db.query(TodChunk).filter_by(intersection_id=intersection_id).all()
    for chunk in chunks:
        if chunk.start_minutes <= minutes < chunk.end_minutes:
            return chunk
    return None


def validate_chunks(chunks: list[TodChunk]) -> None:
    """Raise HTTPException 422 if chunks are not non-overlapping and covering 0–1440."""
    if not chunks:
        raise HTTPException(status_code=422, detail="At least one chunk required")
    sorted_chunks = sorted(chunks, key=lambda c: c.start_minutes)
    if sorted_chunks[0].start_minutes != 0:
        raise HTTPException(status_code=422, detail="Chunks must start at 00:00")
    if sorted_chunks[-1].end_minutes != 1440:
        raise HTTPException(status_code=422, detail="Chunks must end at 24:00")
    for chunk in sorted_chunks:
        if chunk.start_minutes >= chunk.end_minutes:
            raise HTTPException(status_code=422, detail=f"Chunk '{chunk.name}': start must be before end")
    for i in range(len(sorted_chunks) - 1):
        if sorted_chunks[i].end_minutes < sorted_chunks[i + 1].start_minutes:
            raise HTTPException(
                status_code=422,
                detail="Chunks must be contiguous (no gaps)",
            )
