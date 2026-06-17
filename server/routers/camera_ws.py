import asyncio
import json
import os
import queue as stdlib_queue
import threading
import time
from collections import deque

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS",
                      "rtsp_transport;tcp|stimeout;5000000")  # 5 s socket timeout

import cv2
import numpy as np
import redis as redis_lib
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse

from common.database import SessionLocal
from common import models
from common.crypto import decrypt_rtsp_url
from server.utils import get_current_user, get_user_from_token

router = APIRouter(prefix="/cctvs", tags=["Camera WebSocket"])

# Live-preview frame rate the server pushes over the WS, per camera. Each
# additional FPS costs RTSP decode + JPEG encode CPU on the server, and with
# multiple cameras on a CPU-only Mac stack it's the main bottleneck. 10 FPS
# is smooth enough for traffic monitoring; bump via LIVE_PREVIEW_FPS in .env
# if your host has the cycles for it.
_TARGET_FPS = int(os.getenv("LIVE_PREVIEW_FPS", "10"))
_FRAME_INTERVAL = 1.0 / _TARGET_FPS
_REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
_redis = redis_lib.from_url(_REDIS_URL)

_TYPE_COLORS: dict[str, tuple[int, int, int]] = {
    "car":        ( 22, 163,  74),
    "motorcycle": (  3, 105, 161),
    "tricycle":   (217, 119,   6),
    "truck":      (220,  38,  38),
    "pedicab":    (124,  58, 237),
    "pedestrian": (  8, 145, 178),
    "person":     (  8, 145, 178),
}
_DEFAULT_COLOR = (100, 100, 100)

# Hold each frame this long before sending it, so the worker's detection for
# that same frame has time to land in Redis. Higher = better box-frame sync
# but more live-view latency. Lower = snappier video but boxes will trail.
# Tune via OVERLAY_DELAY_SEC in .env; the right value depends on your worker's
# inference batch time, which scales with CAMERAS_PER_WORKER on CPU stacks.
_DELAY_SEC = float(os.getenv("OVERLAY_DELAY_SEC", "0.2"))
_MAX_DET_HISTORY = 120  # detection snapshots to keep (~2 min at 1/s inference)
_OUTPUT_WIDTH = 854     # resize before buffering to reduce memory usage
_LINGER_SEC = 5.0       # keep capture alive after last subscriber leaves

# When enabled, the worker is publishing annotated JPEG frames to Redis. The
# WS handler then bypasses _SharedCapture entirely and just relays bytes from
# Redis pubsub. Eliminates a duplicate RTSP decode per camera and ensures
# boxes always land on the frame they belong to. Must match the worker's
# WORKER_PUBLISHES_FRAMES env or the server will sit on an empty channel.
_RELAY_WORKER_FRAMES = os.getenv("WORKER_PUBLISHES_FRAMES", "0") == "1"


def _draw_boxes(frame: np.ndarray, detections: list[dict]) -> None:
    h, w = frame.shape[:2]
    for det in detections:
        x1 = int(det["x1"] * w)
        y1 = int(det["y1"] * h)
        x2 = int(det["x2"] * w)
        y2 = int(det["y2"] * h)
        color = _TYPE_COLORS.get(det.get("object_type", ""), _DEFAULT_COLOR)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        label = f"{det.get('object_type', '?')} {det.get('confidence', 0):.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        ty = max(y1 - 4, th + 2)
        cv2.rectangle(frame, (x1, ty - th - 2), (x1 + tw + 2, ty + 2), color, -1)
        cv2.putText(frame, label, (x1 + 1, ty),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)


def _enqueue(frame_q: stdlib_queue.Queue, data: bytes) -> None:
    if frame_q.full():
        try:
            frame_q.get_nowait()
        except stdlib_queue.Empty:
            pass
    try:
        frame_q.put_nowait(data)
    except stdlib_queue.Full:
        pass


# ── Shared per-camera RTSP capture ──────────────────────────────────────────

class _SharedCapture:
    """
    One RTSP connection shared among all WebSocket clients viewing the same camera.

    The capture thread reads frames at _TARGET_FPS, maintains the 0.3 s delay
    buffer for worker-detection sync, and broadcasts (frame, boxes) tuples to
    all subscriber queues. Each WebSocket handler draws its own overlay and
    encodes JPEG, so subscribers with overlay=False still get raw frames.
    """

    def __init__(self, rtsp_url: str, cctv_id: int) -> None:
        self.rtsp_url = rtsp_url
        self.cctv_id = cctv_id
        self.stop_event = threading.Event()
        self._lock = threading.Lock()
        self._queues: list[stdlib_queue.Queue] = []
        # Initialise to now so the linger check doesn't fire before first subscribe
        self._last_unsub_ts: float = time.monotonic()
        # Latest detection snapshot from Redis, written by poller thread
        self._det_lock = threading.Lock()
        self._latest_det: tuple[float, list] | None = None  # (det_ts, boxes)
        self._det_thread = threading.Thread(
            target=self._poll_detections, daemon=True, name=f"det-cctv{cctv_id}"
        )
        self._det_thread.start()
        self.thread = threading.Thread(
            target=self._run, daemon=True, name=f"cap-cctv{cctv_id}"
        )
        self.thread.start()

    def subscribe(self) -> "stdlib_queue.Queue[tuple[np.ndarray, list]]":
        q: stdlib_queue.Queue = stdlib_queue.Queue(maxsize=2)
        with self._lock:
            self._queues.append(q)
        return q

    def unsubscribe(self, q: "stdlib_queue.Queue") -> None:
        with self._lock:
            try:
                self._queues.remove(q)
            except ValueError:
                pass
            if not self._queues:
                self._last_unsub_ts = time.monotonic()

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._queues)

    def stop(self) -> None:
        self.stop_event.set()

    def _poll_detections(self) -> None:
        channel = f"cam:{self.cctv_id}:detections:ch"
        # Seed with whatever is already in the key so boxes appear immediately on connect
        try:
            raw = _redis.get(f"cam:{self.cctv_id}:detections")
            if raw:
                data = json.loads(raw)
                boxes  = data.get("boxes", []) if isinstance(data, dict) else data
                det_ts = data.get("ts", time.time()) if isinstance(data, dict) else time.time()
                with self._det_lock:
                    self._latest_det = (det_ts, boxes)
        except Exception:
            pass

        pubsub = _redis.pubsub()
        pubsub.subscribe(channel)
        try:
            while not self.stop_event.is_set():
                msg = pubsub.get_message(timeout=0.5)
                if msg and msg["type"] == "message":
                    try:
                        data = json.loads(msg["data"])
                        boxes  = data.get("boxes", []) if isinstance(data, dict) else data
                        det_ts = data.get("ts", time.time()) if isinstance(data, dict) else time.time()
                        with self._det_lock:
                            self._latest_det = (det_ts, boxes)
                    except Exception:
                        pass
        finally:
            pubsub.unsubscribe(channel)
            pubsub.close()

    def _broadcast(self, frame: np.ndarray, boxes: list) -> None:
        with self._lock:
            for q in list(self._queues):
                if q.full():
                    try:
                        q.get_nowait()
                    except stdlib_queue.Empty:
                        pass
                try:
                    q.put_nowait((frame, boxes))
                except stdlib_queue.Full:
                    pass

    def _broadcast_status(self, status: str) -> None:
        with self._lock:
            for q in list(self._queues):
                try:
                    q.put_nowait((None, status))
                except stdlib_queue.Full:
                    pass

    def _run(self) -> None:
        # (wall_time, frame) - raw frames waiting in the delay buffer
        frame_buf: deque[tuple[float, np.ndarray]] = deque()
        # (det_ts, boxes) - rolling detection snapshot history
        det_history: deque[tuple[float, list]] = deque(maxlen=_MAX_DET_HISTORY)
        last_det_ts = 0.0
        last_read = 0.0

        if not self.rtsp_url:
            print(f"[camera_ws] cctv={self.cctv_id} no RTSP URL, capture thread exiting")
            return

        _STALE_SEC = 3.0  # force-reconnect if no new frame arrives within this window

        print(f"[camera_ws] cctv={self.cctv_id} capture thread started url={self.rtsp_url}")
        cap = cv2.VideoCapture(self.rtsp_url)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        last_frame_ts = time.monotonic()
        try:
            while not self.stop_event.is_set():
                # Exit after linger period with no subscribers
                with self._lock:
                    idle = not self._queues
                    idle_since = self._last_unsub_ts
                if idle and time.monotonic() - idle_since > _LINGER_SEC:
                    break

                ret, frame = cap.read()
                if not ret or (time.monotonic() - last_frame_ts > _STALE_SEC):
                    if ret:
                        print(f"[camera_ws] cctv={self.cctv_id} stale stream, reconnecting...")
                    else:
                        print(f"[camera_ws] cctv={self.cctv_id} read failed, reconnecting...")
                    self._broadcast_status("reconnecting")
                    time.sleep(0.1)
                    cap.release()
                    cap = cv2.VideoCapture(self.rtsp_url)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    last_frame_ts = time.monotonic()
                    continue

                last_frame_ts = time.monotonic()
                mono_now = time.monotonic()
                # Rate-limit intake to _TARGET_FPS
                if mono_now - last_read < _FRAME_INTERVAL:
                    continue
                last_read = mono_now
                wall_now = time.time()

                h, w = frame.shape[:2]
                if w > _OUTPUT_WIDTH:
                    frame = cv2.resize(frame, (_OUTPUT_WIDTH, int(h * _OUTPUT_WIDTH / w)))

                frame_buf.append((wall_now, frame))

                # Absorb latest detection snapshot (written by _poll_detections thread)
                with self._det_lock:
                    latest = self._latest_det
                if latest and latest[0] > last_det_ts:
                    last_det_ts = latest[0]
                    det_history.append(latest)

                # Release frames that have waited long enough, matched to
                # the closest detection snapshot in time for overlay sync.
                while frame_buf and wall_now - frame_buf[0][0] >= _DELAY_SEC:
                    frame_ts, delayed_frame = frame_buf.popleft()
                    best_boxes: list = []
                    best_diff = float("inf")
                    for det_ts, dboxes in det_history:
                        diff = abs(det_ts - frame_ts)
                        if diff < best_diff:
                            best_diff = diff
                            best_boxes = dboxes
                    self._broadcast(delayed_frame, best_boxes)
        except Exception as e:
            print(f"[camera_ws] cctv={self.cctv_id} capture thread crashed: {e}")
        finally:
            cap.release()
            print(f"[camera_ws] cctv={self.cctv_id} capture thread stopped")


_captures: dict[int, _SharedCapture] = {}
_captures_lock = threading.Lock()


def _get_or_create_capture(rtsp_url: str, cctv_id: int) -> _SharedCapture:
    with _captures_lock:
        existing = _captures.get(cctv_id)
        if existing is not None and existing.thread.is_alive() and not existing.stop_event.is_set():
            return existing
        cap = _SharedCapture(rtsp_url, cctv_id)
        _captures[cctv_id] = cap
        return cap


def _release_subscription(cctv_id: int, q: "stdlib_queue.Queue") -> None:
    with _captures_lock:
        cap = _captures.get(cctv_id)
        if cap is None:
            return
        cap.unsubscribe(q)
        # The linger timeout in _run handles teardown - no immediate stop needed.


# ── Snapshot endpoint helpers ────────────────────────────────────────────────

_SNAPSHOT_TIMEOUT = 5.0


def _grab_snapshot(rtsp_url: str, cctv_id: int) -> bytes | None:
    """Open the RTSP stream, grab one frame with boxes, return JPEG bytes."""
    det_key = f"cam:{cctv_id}:detections"
    cap = cv2.VideoCapture(rtsp_url)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    jpeg_bytes: bytes | None = None
    deadline = time.monotonic() + _SNAPSHOT_TIMEOUT
    try:
        while time.monotonic() < deadline:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.05)
                continue

            h, w = frame.shape[:2]
            if w > _OUTPUT_WIDTH:
                frame = cv2.resize(frame, (_OUTPUT_WIDTH, int(h * _OUTPUT_WIDTH / w)))

            raw = _redis.get(det_key)
            if raw:
                try:
                    data = json.loads(raw)
                    boxes = data.get("boxes", []) if isinstance(data, dict) else data
                    _draw_boxes(frame, boxes)
                except Exception:
                    pass

            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if ok:
                jpeg_bytes = buf.tobytes()
            break
    finally:
        cap.release()
    return jpeg_bytes


def _set_viewed(cctv_id: int, value: bool):
    db = SessionLocal()
    try:
        cctv = db.get(models.CCTV, cctv_id)
        if cctv:
            cctv.is_being_viewed = value
            db.commit()
    finally:
        db.close()


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("/{cctv_id}/worker-status")
async def worker_status(
    cctv_id: int,
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Return whether the worker is actively publishing detections for this camera."""
    raw = _redis.get(f"cam:{cctv_id}:detections")
    if raw:
        try:
            data = json.loads(raw)
            last_seen = data.get("ts") if isinstance(data, dict) else None
            return {"worker_live": True, "last_seen": last_seen}
        except Exception:
            pass
    return {"worker_live": False, "last_seen": None}


@router.get("/{cctv_id}/snapshot")
async def camera_snapshot(cctv_id: int, token: str = Query(default="")):
    """Return a single JPEG frame from the camera's RTSP stream."""
    if not get_user_from_token(token):
        raise HTTPException(status_code=401, detail="Not authenticated")

    # When the worker is publishing annotated JPEGs, just return the most
    # recent one - no need to open a second RTSP connection for a snapshot.
    if _RELAY_WORKER_FRAMES:
        cached = _redis.get(f"cam:{cctv_id}:frame")
        if cached:
            return Response(
                content=cached,
                media_type="image/jpeg",
                headers={"Cache-Control": "max-age=5, stale-while-revalidate=10"},
            )
        # Fall through to a live RTSP grab if Redis is empty (e.g. worker
        # hasn't claimed this camera yet) so the dashboard tile still gets
        # *something*.

    db = SessionLocal()
    try:
        cctv = db.get(models.CCTV, cctv_id)
        if not cctv:
            raise HTTPException(status_code=404, detail="CCTV not found")
        rtsp_url = decrypt_rtsp_url(cctv.rtsp_url)
    finally:
        db.close()

    jpeg = await asyncio.to_thread(_grab_snapshot, rtsp_url, cctv_id)
    if jpeg is None:
        raise HTTPException(status_code=503, detail="Stream unavailable")

    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={"Cache-Control": "max-age=5, stale-while-revalidate=10"},
    )


@router.get("/{cctv_id}/boxes/stream")
async def boxes_stream(cctv_id: int, request: Request, token: str = Query(...)):
    """SSE stream of bounding box positions from Redis, polled every 50 ms."""
    if not get_user_from_token(token):
        raise HTTPException(status_code=401, detail="Unauthorized")
    det_key = f"cam:{cctv_id}:detections"

    async def generate():
        last_ts = 0.0
        ticks = 0
        try:
            while True:
                if await request.is_disconnected():
                    break
                ticks += 1
                if ticks % 200 == 0 and not get_user_from_token(token):
                    break
                raw = _redis.get(det_key)
                if raw:
                    try:
                        data = json.loads(raw)
                        ts = data.get("ts", 0.0) if isinstance(data, dict) else 0.0
                        if ts > last_ts:
                            last_ts = ts
                            yield f"data: {raw.decode()}\n\n"
                    except Exception:
                        pass
                await asyncio.sleep(0.05)
        except (asyncio.CancelledError, GeneratorExit):
            pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _relay_worker_frames(websocket: WebSocket, cctv_id: int, token: str) -> None:
    """Forward worker-published JPEG frames from Redis pubsub to the WS client.

    Used when WORKER_PUBLISHES_FRAMES=1. Replaces the entire _SharedCapture
    pipeline - no RTSP decode happens on the server, no overlay drawing, no
    JPEG re-encoding. The boxes are already burned into the JPEG by the
    worker, so they're guaranteed to be on the right frame.
    """
    # Seed the canvas with the most recent frame (if any) so the client
    # doesn't stare at a black tile while waiting for the next pubsub message.
    seed = _redis.get(f"cam:{cctv_id}:frame")
    if seed:
        try:
            await websocket.send_bytes(seed)
        except (WebSocketDisconnect, RuntimeError):
            return

    pubsub = _redis.pubsub()
    pubsub.subscribe(f"cam:{cctv_id}:frame:ch")
    frame_count = 0
    try:
        while True:
            msg = await asyncio.to_thread(pubsub.get_message, True, 5.0)
            if msg is None:
                # No frame for 5 s - either the worker dropped this camera or
                # the slot is reconnecting. Send a status sentinel so the UI
                # can show "reconnecting" instead of a frozen tile.
                try:
                    await websocket.send_text(json.dumps({"status": "reconnecting"}))
                except (WebSocketDisconnect, RuntimeError):
                    break
                continue
            if msg.get("type") != "message":
                continue
            frame_count += 1
            if frame_count % 150 == 0 and not get_user_from_token(token):
                await websocket.close(code=4001)
                break
            try:
                await websocket.send_bytes(msg["data"])
            except (WebSocketDisconnect, RuntimeError):
                break
    finally:
        try:
            pubsub.unsubscribe(f"cam:{cctv_id}:frame:ch")
            pubsub.close()
        except Exception:
            pass


@router.websocket("/{cctv_id}/ws")
async def camera_ws(websocket: WebSocket, cctv_id: int, token: str = "", overlay: bool = True):
    await websocket.accept()
    if not get_user_from_token(token):
        await websocket.close(code=4001)
        return
    db = SessionLocal()
    try:
        cctv = db.get(models.CCTV, cctv_id)
        if not cctv:
            await websocket.close(code=4004)
            return
        rtsp_url = decrypt_rtsp_url(cctv.rtsp_url)
        cctv.is_being_viewed = True
        db.commit()
    finally:
        db.close()

    if _RELAY_WORKER_FRAMES:
        try:
            await _relay_worker_frames(websocket, cctv_id, token)
        finally:
            _set_viewed(cctv_id, False)
        return

    cap = _get_or_create_capture(rtsp_url, cctv_id)
    frame_q = cap.subscribe()

    frame_count = 0
    try:
        while True:
            try:
                item = await asyncio.to_thread(frame_q.get, True, 5.0)
            except stdlib_queue.Empty:
                # No frame for 5 s - shared capture is reconnecting or died.
                if not cap.thread.is_alive():
                    cap.unsubscribe(frame_q)
                    cap = _get_or_create_capture(rtsp_url, cctv_id)
                    frame_q = cap.subscribe()
                continue
            except Exception:
                break

            frame, boxes = item

            # Status sentinel from _broadcast_status - relay as JSON text
            if frame is None:
                try:
                    await websocket.send_text(json.dumps({"status": boxes}))
                except (WebSocketDisconnect, RuntimeError):
                    break
                continue

            if overlay and boxes:
                frame = frame.copy()
                _draw_boxes(frame, boxes)

            ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                continue

            frame_count += 1
            if frame_count % 150 == 0 and not get_user_from_token(token):
                await websocket.close(code=4001)
                break
            try:
                await websocket.send_bytes(jpeg.tobytes())
            except (WebSocketDisconnect, RuntimeError):
                break
    finally:
        _release_subscription(cctv_id, frame_q)
        _set_viewed(cctv_id, False)
