# server/routers/aggregation.py
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from common.database import SessionLocal
from common import models
from server.utils import get_current_user, get_user_from_token
from sqlalchemy import text
from datetime import datetime
from typing import Optional, Literal
import asyncio
import json
import os

router = APIRouter(prefix="/aggregation", tags=["Aggregation"])

_TZ = os.getenv("TZ", "Asia/Manila")

# holds all active SSE connections
connected_clients: list[asyncio.Queue] = []

async def aggregation_pusher():
    """Background task — queries live detection_street_view every 5s and fans out to all clients."""
    while True:
        await asyncio.sleep(5)
        db = SessionLocal()
        try:
            rows = db.execute(text("""
                SELECT
                    intersection_id,
                    intersection_name,
                    street_id,
                    direction,
                    object_type,
                    DATE_TRUNC('day', NOW() AT TIME ZONE :tz) AS window_start,
                    COUNT(*)::int                             AS count
                FROM detection_street_view
                WHERE time >= DATE_TRUNC('day', NOW() AT TIME ZONE :tz) AT TIME ZONE :tz
                GROUP BY intersection_id, intersection_name, street_id, direction, object_type
                ORDER BY intersection_id, street_id, direction, object_type
            """), {"tz": _TZ}).fetchall()

            payload = json.dumps([
                {
                    "intersection_id": r.intersection_id,
                    "intersection_name": r.intersection_name,
                    "street_id": r.street_id,
                    "direction": r.direction,
                    "object_type": r.object_type,
                    "window_start": r.window_start.isoformat(),
                    "count": r.count,
                }
                for r in rows
            ])

            for queue in list(connected_clients):
                await queue.put(payload)

        except Exception as e:
            print(f"[SSE] aggregation query failed: {e}")
        finally:
            db.close()


@router.get("/stream")
async def stream_aggregation(token: str = Query(...)):
    if not get_user_from_token(token):
        raise HTTPException(status_code=401, detail="Unauthorized")
    queue: asyncio.Queue = asyncio.Queue()
    connected_clients.append(queue)

    async def event_generator():
        ticks = 0
        try:
            while True:
                data = await queue.get()
                ticks += 1
                # Re-validate session every 60 ticks (~5 min at 5 s poll interval)
                if ticks % 60 == 0 and not get_user_from_token(token):
                    break
                yield f"data: {data}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            connected_clients.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/history")
def get_history(
    start: datetime,
    end: datetime,
    intersection_id: Optional[int] = None,
    street_id: Optional[int] = None,
    bucket: Literal["hour", "day", "week"] = "day",
    user: models.User = Depends(get_current_user),
):
    """Return aggregation_summaries for a date range, bucketed by hour/day/week."""
    # bucket is a Literal so it is safe to interpolate
    trunc = bucket

    conditions = ["a.window_start >= :start", "a.window_start < :end"]
    params: dict = {"start": start, "end": end}

    if intersection_id is not None:
        conditions.append("a.intersection_id = :intersection_id")
        params["intersection_id"] = intersection_id
    if street_id is not None:
        conditions.append("a.street_id = :street_id")
        params["street_id"] = street_id

    where = " AND ".join(conditions)

    # For recent ranges (≤2 days, hour bucket) query the live view directly
    # so data is real-time. For longer ranges use the continuous aggregate
    # which is pre-computed and fast over large windows.
    use_live = (bucket == "hour" and (end - start).total_seconds() <= 172_800)

    if use_live:
        conditions_live = [c.replace("a.window_start", "a.time") for c in conditions]
        where_live = " AND ".join(conditions_live)
        query = f"""
            SELECT
                a.intersection_id,
                a.intersection_name,
                a.street_id,
                a.direction,
                a.object_type,
                DATE_TRUNC('{trunc}', a.time)  AS window_start,
                COUNT(*)::int                   AS count
            FROM detection_street_view a
            WHERE {where_live}
            GROUP BY
                a.intersection_id, a.intersection_name, a.street_id, a.direction, a.object_type,
                DATE_TRUNC('{trunc}', a.time)
            ORDER BY
                DATE_TRUNC('{trunc}', a.time),
                a.intersection_id, a.street_id, a.direction, a.object_type
        """
    else:
        query = f"""
            SELECT
                a.intersection_id,
                i.name          AS intersection_name,
                a.street_id,
                a.direction,
                a.object_type,
                DATE_TRUNC('{trunc}', a.window_start) AS window_start,
                SUM(a.count)::int                      AS count
            FROM aggregation_summaries a
            JOIN intersections i ON i.id = a.intersection_id
            WHERE {where}
            GROUP BY
                a.intersection_id, i.name, a.street_id, a.direction, a.object_type,
                DATE_TRUNC('{trunc}', a.window_start)
            ORDER BY
                DATE_TRUNC('{trunc}', a.window_start),
                a.intersection_id, a.street_id, a.direction, a.object_type
        """

    db = SessionLocal()
    try:
        rows = db.execute(text(query), params).fetchall()

        return [
            {
                "intersection_id": r.intersection_id,
                "intersection_name": r.intersection_name,
                "street_id": r.street_id,
                "direction": r.direction,
                "object_type": r.object_type,
                "window_start": r.window_start.isoformat(),
                "count": r.count,
            }
            for r in rows
        ]
    finally:
        db.close()