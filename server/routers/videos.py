import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from common.database import get_db
from common import models
from server.utils import get_current_user
from server.rate_limit import limiter
from worker.queue import video_queue

router = APIRouter(tags=["Videos & Push"])

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "")

_MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "500")) * 1024 * 1024
_ALLOWED_SUFFIXES = {".mp4", ".avi", ".mov", ".mkv", ".m4v", ".wmv", ".flv", ".webm"}

class PushSubscribePayload(BaseModel):
    endpoint: str
    keys: dict  # { p256dh, auth }


class PushUnsubscribePayload(BaseModel):
    endpoint: str


# ---------------------------------------------------------------------------
# Video upload
# ---------------------------------------------------------------------------

@router.post("/videos/upload")
@limiter.limit("20/minute")
async def upload_video(
    request:         Request,
    file:            UploadFile      = File(...),
    intersection_id: int | None      = Form(None),
    recorded_at:     str             = Form(None),
    db:              Session         = Depends(get_db),
    user:            models.User     = Depends(get_current_user),
):
    """
    Save the uploaded video to disk, create a videos row, enqueue the
    RQ processing job, and return the video_id immediately.
    intersection_id is optional - omit to analyse the video standalone.
    The browser can close - processing continues in the background.
    """
    suffix = Path(file.filename or "upload").suffix.lower() or ".mp4"
    if suffix not in _ALLOWED_SUFFIXES:
        raise HTTPException(status_code=422, detail=f"Unsupported file type '{suffix}'. Allowed: {', '.join(sorted(_ALLOWED_SUFFIXES))}")

    if intersection_id is not None:
        intersection = db.query(models.Intersection).filter(
            models.Intersection.id == intersection_id
        ).first()
        if not intersection:
            raise HTTPException(status_code=404, detail="Intersection not found")

    unique   = uuid.uuid4().hex
    filename = f"{unique}{suffix}"
    filepath = UPLOAD_DIR / filename

    try:
        written = 0
        with filepath.open("wb") as f:
            while True:
                chunk = await file.read(65_536)
                if not chunk:
                    break
                written += len(chunk)
                if written > _MAX_UPLOAD_BYTES:
                    f.close()
                    filepath.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds maximum allowed size of {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB",
                    )
                f.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        filepath.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"File save failed: {e}")

    recorded_at_dt = None
    if recorded_at:
        try:
            recorded_at_dt = datetime.fromisoformat(recorded_at)
            if recorded_at_dt.tzinfo is None:
                recorded_at_dt = recorded_at_dt.replace(tzinfo=timezone.utc)
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid recorded_at format, use ISO 8601")

    video = models.Video(  # type: ignore[call-arg]
        intersection_id=intersection_id,
        uploaded_by=int(user.id),  # type: ignore
        filename=file.filename or filename,
        filepath=str(filepath),
        recorded_at=recorded_at_dt,
        status="pending",
    )
    db.add(video)
    db.commit()
    db.refresh(video)

    video_id = int(video.id)  # type: ignore

    job = video_queue.enqueue(
        "worker.video_job.process_video",
        video_id,
        job_timeout=3600,
    )

    print(f"[upload] video_id={video_id} job_id={job.id} user={user.username}")

    return JSONResponse({
        "video_id": video_id,
        "job_id":   job.id,
        "status":   "pending",
        "message":  "Video uploaded. Processing has started in the background.",
    })


@router.get("/videos/{video_id}/status")
def get_video_status(
    video_id: int,
    db:       Session = Depends(get_db),
    user:     models.User = Depends(get_current_user),
):
    """Poll this to track processing progress."""
    video = db.query(models.Video).filter(models.Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    return {
        "video_id":         video_id,
        "status":           video.status,
        "total_frames":     video.total_frames,
        "processed_frames": video.processed_frames,
        "percent": (
            round(video.processed_frames / video.total_frames * 100, 1) # type: ignore
            if video.total_frames else 0 # type: ignore
        ),
        "processed_at": video.processed_at,
    }


@router.get("/videos")
def list_videos(
    db:   Session      = Depends(get_db),
    user: models.User  = Depends(get_current_user),
):
    """List all uploaded videos for the current user."""
    videos = (
        db.query(models.Video)
        .filter(models.Video.uploaded_by == int(user.id))  # type: ignore
        .order_by(models.Video.uploaded_at.desc())
        .all()
    )
    return [
        {
            "video_id":         int(v.id),  # type: ignore
            "filename":         v.filename,
            "status":           v.status,
            "total_frames":     v.total_frames,
            "processed_frames": v.processed_frames,
            "uploaded_at":      v.uploaded_at,
            "processed_at":     v.processed_at,
        }
        for v in videos
    ]


# ---------------------------------------------------------------------------
# Video analytics
# ---------------------------------------------------------------------------

@router.get("/videos/{video_id}/analytics")
def get_video_analytics(
    video_id: int,
    db:       Session      = Depends(get_db),
    user:     models.User  = Depends(get_current_user),
):
    """
    Return per-object-type detection counts and a time-series (bucketed by
    minute) for a specific video.  Works regardless of intersection assignment.
    """
    video = db.query(models.Video).filter(models.Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # Totals by object type
    type_rows = db.execute(text("""
        SELECT object_type, COUNT(*)::int AS total
        FROM detections
        WHERE video_id = :vid
        GROUP BY object_type
        ORDER BY total DESC
    """), {"vid": video_id}).fetchall()

    # Time-series bucketed by minute relative to recording start
    ts_rows = db.execute(text("""
        SELECT
            DATE_TRUNC('minute', time)  AS bucket,
            object_type,
            COUNT(*)::int               AS total
        FROM detections
        WHERE video_id = :vid
        GROUP BY DATE_TRUNC('minute', time), object_type
        ORDER BY bucket
    """), {"vid": video_id}).fetchall()

    return {
        "video_id":   video_id,
        "filename":   video.filename,
        "status":     video.status,
        "recorded_at": video.recorded_at.isoformat() if video.recorded_at else None,
        "by_type": [
            {"object_type": r.object_type, "count": r.total}
            for r in type_rows
        ],
        "time_series": [
            {
                "bucket":      r.bucket.isoformat(),
                "object_type": r.object_type,
                "count":       r.total,
            }
            for r in ts_rows
        ],
    }


# ---------------------------------------------------------------------------
# Push notification endpoints
# ---------------------------------------------------------------------------

@router.get("/push/vapid-public-key")
def get_vapid_public_key():
    """Return VAPID public key for the frontend to create a push subscription."""
    if not VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    return {"public_key": VAPID_PUBLIC_KEY}


@router.post("/push/subscribe")
def subscribe_push(
    payload: PushSubscribePayload,
    db:      Session      = Depends(get_db),
    user:    models.User  = Depends(get_current_user),
):
    """
    Save a browser push subscription linked to the current user.
    Payload: { endpoint, keys: { p256dh, auth } }
    """
    p256dh = payload.keys.get("p256dh")
    auth   = payload.keys.get("auth")

    if not all([payload.endpoint, p256dh, auth]):
        raise HTTPException(status_code=422, detail="Missing endpoint, p256dh, or auth")

    existing = db.query(models.PushSubscription).filter(
        models.PushSubscription.endpoint == payload.endpoint
    ).first()

    if existing:
        existing.p256dh  = p256dh   # type: ignore
        existing.auth    = auth      # type: ignore
        existing.user_id = int(user.id)  # type: ignore
        db.commit()
        return {"message": "Subscription updated"}

    sub = models.PushSubscription(  # type: ignore[call-arg]
        user_id=int(user.id),  # type: ignore
        endpoint=payload.endpoint,
        p256dh=p256dh,
        auth=auth,
    )
    db.add(sub)
    db.commit()
    return {"message": "Subscription saved"}


@router.delete("/push/subscribe")
def unsubscribe_push(
    payload: PushUnsubscribePayload,
    db:      Session      = Depends(get_db),
    user:    models.User  = Depends(get_current_user),
):
    """Remove a push subscription when the user revokes permission."""
    sub = db.query(models.PushSubscription).filter(
        models.PushSubscription.endpoint == payload.endpoint
    ).first()

    if sub:
        db.delete(sub)
        db.commit()

    return {"message": "Subscription removed"}