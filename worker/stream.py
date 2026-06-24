from sqlalchemy.orm import Session
from sqlalchemy import text
from common import models
from common.crypto import decrypt_rtsp_url
import argparse
import os
import time
import cv2

_REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
try:
    import redis as _redis_lib
    _redis = _redis_lib.from_url(_REDIS_URL, socket_connect_timeout=1)
except Exception:
    _redis = None

# TCP transport + 10-second socket timeout so a dead MediaMTX/OBS stream fails fast
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|stimeout;10000000",
)

_PASSTHROUGH_SCHEMES = ("rtsp://", "rtsps://", "rtmp://", "rtmps://", "http://", "https://")


def resolve_rtsp_url(cctv: models.CCTV, args: argparse.Namespace) -> str | None:
    """
    If cctv.rtsp_url is already a full stream URL (RTSP, RTMP, HLS over HTTP,
    etc.), use it as-is - FFmpeg opens any of these. Otherwise treat the
    value as a bare Dahua-style host/IP and build the default RTSP path.
    Returns None when --debug (webcam instead of a network stream).
    """
    if args.debug:
        return None
    raw = decrypt_rtsp_url((cctv.rtsp_url or "").strip())
    lower = raw.lower()
    if any(lower.startswith(scheme) for scheme in _PASSTHROUGH_SCHEMES):
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
    """Validate the stream by reading a frame - isOpened() alone lies on MediaMTX."""
    if not cap.isOpened():
        return False
    ret, _ = cap.read()
    return ret


def _sleep_interruptible(cctv_id: int, delay: float) -> None:
    """Sleep for `delay` seconds, but wake early if a Redis retry_now signal is set."""
    if _redis is None:
        time.sleep(delay)
        return
    key = f"cam:{cctv_id}:retry_now"
    deadline = time.time() + delay
    while time.time() < deadline:
        try:
            if _redis.get(key):
                _redis.delete(key)
                return
        except Exception:
            pass
        remaining = deadline - time.time()
        time.sleep(min(0.5, max(0.0, remaining)))


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
            "UPDATE worker_heartbeats SET status = 'reconnecting', last_seen = NOW() WHERE cctv_id = :id"
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
        _sleep_interruptible(cctv_id, delay)
        cap = open_stream(rtsp_url, debug)
        if _stream_is_live(cap):
            print(f"[worker cctv={cctv_id}] reconnected after {attempt} attempt(s)")
            try:
                db.execute(text(
                    "UPDATE cctvs SET status = 'online' WHERE id = :id"
                ), {"id": cctv_id})
                db.execute(text(
                    "UPDATE worker_heartbeats SET status = 'running', last_error = NULL WHERE cctv_id = :id"
                ), {"id": cctv_id})
                db.commit()
            except Exception as e:
                print(f"[worker cctv={cctv_id}] failed to update online status: {e}")
                db.rollback()
            return cap

        error_msg = f"RTSP connection failed (attempt {attempt}): {rtsp_url}"
        print(f"[worker cctv={cctv_id}] {error_msg}")
        try:
            db.execute(text(
                "UPDATE worker_heartbeats SET last_error = :err, last_seen = NOW() WHERE cctv_id = :id"
            ), {"err": error_msg[:500], "id": cctv_id})
            db.commit()
        except Exception:
            db.rollback()

        cap.release()
        # Backoff cap raised from 60 s → 300 s. With dozens of dead cameras a
        # 60 s ceiling means a sustained ~1 reconnect/s storm of FFMPEG dials
        # plus a heartbeat UPDATE per slot, which kept TimescaleDB at 250%+
        # CPU and made the UI sluggish. The Redis `cam:{id}:retry_now` signal
        # still wakes the sleeper early when an operator hits "retry" in the
        # UI, so the longer cap doesn't hurt manual recovery latency.
        delay = min(delay * 2, 300)