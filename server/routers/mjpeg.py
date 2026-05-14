import asyncio
import queue as stdlib_queue
import threading
import time

import cv2
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from common.database import SessionLocal
from common import models
from common.crypto import decrypt_rtsp_url
from server.utils import get_user_from_token

router = APIRouter(prefix="/cctvs", tags=["MJPEG"])


def _capture_thread(rtsp_url: str, frame_q: stdlib_queue.Queue, stop_event: threading.Event):
    cap = cv2.VideoCapture(rtsp_url)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    try:
        while not stop_event.is_set():
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.1)
                cap.release()
                cap = cv2.VideoCapture(rtsp_url)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                continue
            ok, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if not ok:
                continue
            data = jpeg.tobytes()
            # Drop oldest frame so consumer always gets the freshest
            if frame_q.full():
                try:
                    frame_q.get_nowait()
                except stdlib_queue.Empty:
                    pass
            try:
                frame_q.put_nowait(data)
            except stdlib_queue.Full:
                pass
    finally:
        cap.release()


def _set_viewed(cctv_id: int, value: bool):
    db = SessionLocal()
    try:
        cctv = db.get(models.CCTV, cctv_id)
        if cctv:
            cctv.is_being_viewed = value
            db.commit()
    finally:
        db.close()


@router.get("/{cctv_id}/stream")
async def mjpeg_stream(
    cctv_id: int,
    token: str = Query(...),
):
    if not get_user_from_token(token):
        raise HTTPException(status_code=401, detail="Unauthorized")

    db = SessionLocal()
    try:
        cctv = db.get(models.CCTV, cctv_id)
        if not cctv:
            raise HTTPException(status_code=404, detail="Camera not found")
        rtsp_url = decrypt_rtsp_url(cctv.rtsp_url)
        cctv.is_being_viewed = True
        db.commit()
    finally:
        db.close()

    frame_q: stdlib_queue.Queue = stdlib_queue.Queue(maxsize=2)
    stop_event = threading.Event()
    thread = threading.Thread(
        target=_capture_thread,
        args=(rtsp_url, frame_q, stop_event),
        daemon=True,
    )
    thread.start()

    async def frame_generator():
        timeouts = 0
        try:
            while True:
                try:
                    # Run blocking queue.get in thread pool - non-blocking for asyncio
                    frame_bytes = await asyncio.to_thread(frame_q.get, True, 5.0)
                    timeouts = 0
                except Exception:
                    timeouts += 1
                    if timeouts >= 2:
                        break
                    continue
                yield (
                    b'--frame\r\n'
                    b'Content-Type: image/jpeg\r\n\r\n'
                    + frame_bytes
                    + b'\r\n'
                )
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            stop_event.set()
            _set_viewed(cctv_id, False)

    return StreamingResponse(
        frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
            "Pragma": "no-cache",
        },
    )
