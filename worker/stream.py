from sqlalchemy.orm import Session
from sqlalchemy import text
from common import models
from common.crypto import decrypt_rtsp_url
import argparse
import os
import time
import cv2

# TCP transport + 10-second socket timeout so a dead MediaMTX/OBS stream fails fast
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|stimeout;10000000",
)

def resolve_rtsp_url(cctv: models.CCTV, args: argparse.Namespace) -> str | None:
    """
    If cctv.rtsp_url is a full RTSP URL (MediaMTX, etc.), use it as-is.
    Otherwise treat it as a Dahua-style host/IP and build the default path.
    Returns None when --debug (webcam instead of RTSP).
    """
    if args.debug:
        return None
    raw = decrypt_rtsp_url((cctv.rtsp_url or "").strip())
    lower = raw.lower()
    if lower.startswith("rtsp://") or lower.startswith("rtsps://"):
        return raw
    return (
        f"rtsp://{args.username}:{args.password}@{raw}:{args.port}"
        f"/cam/realmonitor?channel={args.channel}&subtype={1 if args.subtype else 0}"
    )


def open_stream(rtsp_url: str | None, debug: bool) -> cv2.VideoCapture:
    source = 2 if debug else rtsp_url
    if source is None:
        raise ValueError("rtsp_url is None and debug mode is off")
    cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def _stream_is_live(cap: cv2.VideoCapture) -> bool:
    """Validate the stream by reading a frame — isOpened() alone lies on MediaMTX."""
    if not cap.isOpened():
        return False
    ret, _ = cap.read()
    return ret


def reconnect_stream(
    rtsp_url: str | None,
    debug: bool,
    db: Session,
    cctv_id: int,
) -> cv2.VideoCapture:
    """
    Update camera status to reconnecting and retry the RTSP connection
    with exponential backoff. The heartbeat keeps running during this
    period so the claim stays alive.
    """
    try:
        db.execute(text(
            "UPDATE cctvs SET status = 'reconnecting' WHERE id = :id"
        ), {"id": cctv_id})
        db.execute(text(
            "UPDATE worker_heartbeats SET status = 'reconnecting' WHERE cctv_id = :id"
        ), {"id": cctv_id})
        db.commit()
    except Exception as e:
        print(f"[worker cctv={cctv_id}] failed to update reconnecting status: {e}")
        db.rollback()

    delay = 2
    attempt = 0
    while True:
        attempt += 1
        print(f"[worker cctv={cctv_id}] reconnect attempt {attempt}, waiting {delay}s...")
        time.sleep(delay)
        cap = open_stream(rtsp_url, debug)
        if _stream_is_live(cap):
            print(f"[worker cctv={cctv_id}] reconnected")
            try:
                db.execute(text(
                    "UPDATE cctvs SET status = 'active' WHERE id = :id"
                ), {"id": cctv_id})
                db.execute(text(
                    "UPDATE worker_heartbeats SET status = 'running' WHERE cctv_id = :id"
                ), {"id": cctv_id})
                db.commit()
            except Exception as e:
                print(f"[worker cctv={cctv_id}] failed to update active status: {e}")
                db.rollback()
            return cap
        cap.release()
        delay = min(delay * 2, 60)