import argparse
import json as _json
import os
import queue
import signal
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Set

import cv2
import numpy as np
import redis as redis_lib
from sqlalchemy import text
from sqlalchemy.orm import Session
from ultralytics import YOLO

from common import models
from common.database import Base, SessionLocal, engine
from common.geometry import is_point_in_polygon
from worker.claim import try_claim_camera, release_camera, verify_claim
from worker.heartbeat import HeartbeatThread
from worker.stream import open_stream, reconnect_stream, resolve_rtsp_url, _stream_is_live

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
_redis = redis_lib.from_url(REDIS_URL)

CAMERAS_PER_WORKER    = int(os.getenv("CAMERAS_PER_WORKER", "16"))
INFERENCE_EVERY_N     = int(os.getenv("INFERENCE_EVERY_N", "1"))   # process 1-in-N frames for DB writes
PRUNE_INTERVAL_SEC    = 10
TRACK_MAX_AGE_SEC     = 30
FPS_SAMPLE_INTERVAL   = 30
FLUSH_INTERVAL_SEC    = 0.3
MAX_BUFFER_SIZE       = 1000
CLAIM_CHECK_FRAMES    = 100
RECLAIM_INTERVAL      = 5.0   # seconds between slot-fill attempts
REGION_REFRESH_SEC    = 60.0  # re-read regions from DB in case polygons changed

_DUMMY_FRAME = np.zeros((480, 854, 3), dtype=np.uint8)


@dataclass
class TrackState:
    track_id: int
    cls_name: str
    db_detection_id: Optional[int] = None
    regions_entered: Set[int] = field(default_factory=set)
    last_seen_ts: float = field(default_factory=time.time)


@dataclass
class CameraSlot:
    cctv_id: int
    claim_version: int
    rtsp_url: str
    regions: list
    track_states: dict = field(default_factory=dict)
    dir_buffer: list = field(default_factory=list)
    frame_q: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=1))
    fps_ref: list = field(default_factory=lambda: [0.0])
    heartbeat: Optional[HeartbeatThread] = None
    reader_thread: Optional[threading.Thread] = None
    stop_event: threading.Event = field(default_factory=threading.Event)
    frame_count: int = 0
    last_flush_ts: float = field(default_factory=time.time)
    last_prune_ts: float = field(default_factory=time.time)
    fps_timer_start: float = field(default_factory=time.time)
    claim_lost: bool = False
    last_frame: Optional[np.ndarray] = None
    last_region_refresh_ts: float = field(default_factory=time.time)
    saved_trackers: Optional[list] = None   # per-camera ByteTrack state


def _camera_reader(
    rtsp_url: str,
    cctv_id: int,
    frame_q: queue.Queue,
    stop_event: threading.Event,
    args: argparse.Namespace,
) -> None:
    """Read frames from one RTSP stream, always keeping the queue fresh."""
    db = SessionLocal()
    cap = open_stream(rtsp_url, args.debug)
    if not _stream_is_live(cap):
        cap.release()
        cap = reconnect_stream(rtsp_url, args.debug, db, cctv_id)
    try:
        while not stop_event.is_set():
            ret, frame = cap.read()
            # drain extra buffered frames to stay current
            for _ in range(2):
                ok, fresh = cap.read()
                if ok:
                    frame = fresh

            if not ret:
                cap.release()
                if stop_event.is_set():
                    break
                cap = reconnect_stream(rtsp_url, args.debug, db, cctv_id)
                continue

            # replace stale frame in queue with latest
            try:
                frame_q.get_nowait()
            except queue.Empty:
                pass
            try:
                frame_q.put_nowait(frame)
            except queue.Full:
                pass
    finally:
        cap.release()
        db.close()


def _start_slot(cctv: models.CCTV, claim_version: int, args: argparse.Namespace, db: Session) -> CameraSlot:
    rtsp_url = resolve_rtsp_url(cctv, args)
    slot = CameraSlot(
        cctv_id=cctv.id,
        claim_version=claim_version,
        rtsp_url=rtsp_url,
        regions=initialize_regions(db, cctv.id),
    )
    slot.reader_thread = threading.Thread(
        target=_camera_reader,
        args=(rtsp_url, cctv.id, slot.frame_q, slot.stop_event, args),
        daemon=True,
        name=f"reader-cam{cctv.id}",
    )
    slot.reader_thread.start()
    slot.heartbeat = HeartbeatThread(cctv_id=cctv.id, fps_ref=slot.fps_ref)
    slot.heartbeat.start()
    print(f"[worker] slot started cctv={cctv.id} name='{cctv.name}'")
    return slot


def _stop_slot(slot: CameraSlot, db: Session, release: bool) -> None:
    slot.stop_event.set()
    slot.heartbeat.stop()
    slot.heartbeat.join(timeout=5)
    flush_detection_buffer(db, slot.dir_buffer)
    if release:
        release_camera(db, slot.cctv_id)
    print(f"[worker] slot stopped cctv={slot.cctv_id} release={release}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password", default="admin")
    parser.add_argument("--port",    type=int, default=554)
    parser.add_argument("--channel", type=int, default=1)
    parser.add_argument("--subtype", action="store_true")
    parser.add_argument("--debug",   action="store_true")
    parser.add_argument("--show",    action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    model = _load_model()

    # warm up GPU kernels so first real frame isn't slow
    _dummy = np.zeros((480, 854, 3), dtype=np.uint8)
    model([_dummy], verbose=False)
    print(f"[worker] model warmed up, claiming up to {CAMERAS_PER_WORKER} cameras")

    slots: list[CameraSlot] = []

    _shutdown = threading.Event()
    def _sigterm(sig, frame):
        print("[worker] SIGTERM received, shutting down...")
        _shutdown.set()
    signal.signal(signal.SIGTERM, _sigterm)

    # claim initial batch of cameras
    while len(slots) < CAMERAS_PER_WORKER:
        result = try_claim_camera(db)
        if result is None:
            break
        cctv, version = result
        slots.append(_start_slot(cctv, version, args, db))

    last_claim_attempt = time.time()

    try:
        while not _shutdown.is_set():
            now = time.time()

            # fill any open slots
            if len(slots) < CAMERAS_PER_WORKER and now - last_claim_attempt >= RECLAIM_INTERVAL:
                result = try_claim_camera(db)
                if result is not None:
                    cctv, version = result
                    slots.append(_start_slot(cctv, version, args, db))
                last_claim_attempt = now

            # Process each camera independently — TRT engine has static batch=1,
            # so we call model.track once per slot and swap per-camera ByteTrack
            # state in/out so track IDs don't collide across cameras.
            any_new = False
            target_h, target_w = _DUMMY_FRAME.shape[:2]

            for slot in slots:
                try:
                    frame = slot.frame_q.get_nowait()
                    slot.last_frame = frame
                except queue.Empty:
                    continue  # no new frame this cycle for this camera

                any_new = True
                Path("/tmp/worker-alive").touch()

                # Normalize to model input size
                if frame.shape[:2] != (target_h, target_w):
                    frame = cv2.resize(frame, (target_w, target_h))

                # Swap in this camera's tracker state so track IDs don't bleed
                # across cameras (each slot keeps its own ByteTrack instance).
                #
                # ultralytics on_predict_start skips tracker creation when
                # (hasattr(predictor, "trackers") AND persist=True).
                # So: if we HAVE saved state → set the attribute (creation skipped, state reused).
                #     if this is the FIRST call → DELETE the attribute so on_predict_start
                #     creates a fresh tracker for this camera.
                predictor = getattr(model, 'predictor', None)
                if predictor is not None:
                    if slot.saved_trackers is not None:
                        predictor.trackers = slot.saved_trackers
                    elif hasattr(predictor, 'trackers'):
                        del predictor.trackers

                results = model.track([frame], persist=True, verbose=args.verbose)[0]

                # Save updated tracker state for next cycle
                predictor = getattr(model, 'predictor', None)
                if predictor is not None and hasattr(predictor, 'trackers') and predictor.trackers:
                    slot.saved_trackers = list(predictor.trackers)

                slot.frame_count += 1
                frame_h, frame_w = frame.shape[:2]

                # publish bounding boxes to Redis for camera_ws overlay (every frame)
                try:
                    boxes_payload = []
                    for box in results.boxes:
                        if box.id is None:
                            continue
                        bx1, by1, bx2, by2 = box.xyxy[0].tolist()
                        boxes_payload.append({
                            "track_id":    int(box.id[0]),
                            "object_type": model.names[int(box.cls[0])],
                            "confidence":  round(float(box.conf[0]), 3),
                            "x1": round(bx1 / frame_w, 4),
                            "y1": round(by1 / frame_h, 4),
                            "x2": round(bx2 / frame_w, 4),
                            "y2": round(by2 / frame_h, 4),
                        })
                    _redis.setex(f"cam:{slot.cctv_id}:detections", 5, _json.dumps({
                        "ts":    now,
                        "boxes": boxes_payload,
                    }))
                except Exception:
                    pass

                # frame skipping: skip DB writes on non-sampled frames
                if INFERENCE_EVERY_N > 1 and slot.frame_count % INFERENCE_EVERY_N != 0:
                    if args.show:
                        cv2.imshow(f"cctv-{slot.cctv_id}", frame)
                    continue

                # per-detection DB processing
                for box in results.boxes:
                    if box.id is None:
                        continue
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    process_detection(
                        db, slot.regions, slot.track_states,
                        int(box.id[0]),
                        model.names[int(box.cls[0])],
                        float(box.conf[0]),
                        (x1, y1, x2, y2),
                        slot.cctv_id, frame_w, frame_h,
                        slot.dir_buffer,
                    )

                if args.show:
                    annotated = results.plot()
                    annotated = draw_regions(annotated, slot.regions, frame_w, frame_h)
                    cv2.imshow(f"cctv-{slot.cctv_id}", annotated)

                # FPS sample
                if slot.frame_count % FPS_SAMPLE_INTERVAL == 0:
                    elapsed = now - slot.fps_timer_start
                    slot.fps_ref[0] = round(FPS_SAMPLE_INTERVAL / elapsed if elapsed > 0 else 0, 1)
                    slot.fps_timer_start = now

                # flush detection buffer
                if now - slot.last_flush_ts >= FLUSH_INTERVAL_SEC:
                    flush_detection_buffer(db, slot.dir_buffer)
                    slot.last_flush_ts = now

                # prune stale tracks
                if now - slot.last_prune_ts >= PRUNE_INTERVAL_SEC:
                    prune_tracks(slot.track_states)
                    slot.last_prune_ts = now

                # refresh region polygons in case they changed in the DB
                if now - slot.last_region_refresh_ts >= REGION_REFRESH_SEC:
                    _rdb = SessionLocal()
                    try:
                        slot.regions = initialize_regions(_rdb, slot.cctv_id)
                    finally:
                        _rdb.close()
                    slot.last_region_refresh_ts = now

                # verify claim fencing token
                if slot.frame_count % CLAIM_CHECK_FRAMES == 0:
                    if not verify_claim(db, slot.cctv_id, slot.claim_version):
                        slot.claim_lost = True

            if not any_new:
                time.sleep(0.01)

            if args.show and cv2.waitKey(1) & 0xFF == ord("q"):
                break

            # evict slots that lost their claim
            lost = [s for s in slots if s.claim_lost]
            for slot in lost:
                slots.remove(slot)
                _stop_slot(slot, db, release=False)

    finally:
        if args.show:
            cv2.destroyAllWindows()
        for slot in slots:
            _stop_slot(slot, db, release=True)
        db.close()


# ── helpers ────────────────────────────────────────────────────────────────────

def _load_model() -> YOLO:
    trt_cache = os.getenv("TRT_CACHE_DIR", "/app/trt_cache")
    engine_path = Path(trt_cache) / "eyegila_v3.engine"
    if engine_path.exists():
        print(f"[worker] loading TensorRT FP16 engine from {engine_path}")
        return YOLO(str(engine_path), task="detect")
    print("[worker] TensorRT engine not found — loading PyTorch weights (eyegila_v3.pt)")
    return YOLO("eyegila_v3.pt")


def initialize_regions(db: Session, cctv_id: int) -> list[dict]:
    regions = []
    for db_region in db.query(models.Region).filter(models.Region.cctv_id == cctv_id).all():
        regions.append({
            "id": db_region.id,
            "street_id": db_region.street_id,
            "region_points": [{"id": pt.id, "x": pt.x, "y": pt.y}
                               for pt in db_region.region_points],
        })
    return regions


def process_detection(
    db: Session,
    regions: list[dict],
    track_states: dict,
    track_id: int,
    cls_name: str,
    confidence: float,
    bounding_box: tuple,
    cctv_id: int,
    frame_w: int,
    frame_h: int,
    dir_buffer: list,
) -> None:
    x1, y1, x2, y2 = bounding_box
    cx = ((x1 + x2) / 2) / frame_w
    cy = ((y1 + y2) / 2) / frame_h
    center = (cx, cy)

    if track_id not in track_states:
        track_states[track_id] = TrackState(track_id=track_id, cls_name=cls_name)

    state = track_states[track_id]
    state.last_seen_ts = time.time()

    if state.db_detection_id is None:
        detection = models.Detection(
            cctv_id=cctv_id,
            track_id=track_id,
            object_type=cls_name,
            confidence=round(confidence, 4),
            x1=round(x1 / frame_w, 4),
            y1=round(y1 / frame_h, 4),
            x2=round(x2 / frame_w, 4),
            y2=round(y2 / frame_h, 4),
        )
        try:
            db.add(detection)
            db.flush()
        except Exception as e:
            print(f"[worker] detection write failed: {e}")
            db.rollback()
            return

        state.db_detection_id = int(detection.id)  # type: ignore

        for region in regions:
            if is_point_in_polygon(center, [(p["x"], p["y"]) for p in region["region_points"]]):
                state.regions_entered.add(region["id"])
                if len(dir_buffer) >= MAX_BUFFER_SIZE:
                    dir_buffer.pop(0)
                dir_buffer.append({"region_id": region["id"], "detection_id": state.db_detection_id})
        return

    for region in regions:
        region_id = region["id"]
        if (is_point_in_polygon(center, [(p["x"], p["y"]) for p in region["region_points"]])
                and region_id not in state.regions_entered):
            state.regions_entered.add(region_id)
            if len(dir_buffer) >= MAX_BUFFER_SIZE:
                dir_buffer.pop(0)
            dir_buffer.append({"region_id": region_id, "detection_id": state.db_detection_id})


def flush_detection_buffer(db: Session, dir_buffer: list) -> None:
    items = dir_buffer.copy()
    dir_buffer.clear()
    try:
        if items:
            db.bulk_insert_mappings(models.DetectionInRegion, items)  # type: ignore
        db.commit()
    except Exception:
        db.rollback()
        bad_regions: set[int] = set()
        for item in items:
            try:
                db.execute(
                    text("INSERT INTO detections_in_regions (region_id, detection_id) VALUES (:r, :d)"),
                    {"r": item["region_id"], "d": item["detection_id"]},
                )
                db.commit()
            except Exception:
                db.rollback()
                bad_regions.add(item["region_id"])
        if bad_regions:
            print(f"[worker] skipped stale region_ids {bad_regions}")


def prune_tracks(track_states: dict, max_age_seconds: float = TRACK_MAX_AGE_SEC) -> None:
    now = time.time()
    stale = [tid for tid, s in track_states.items() if now - s.last_seen_ts > max_age_seconds]
    for tid in stale:
        del track_states[tid]


def draw_regions(frame: np.ndarray, regions: list, frame_w: int, frame_h: int) -> np.ndarray:
    colors = [(0, 255, 0), (255, 0, 0), (0, 165, 255), (0, 0, 255), (255, 0, 255)]
    for i, region in enumerate(regions):
        color = colors[i % len(colors)]
        points = region["region_points"]
        if len(points) < 3:
            continue
        pixel_pts = [(int(p["x"] * frame_w), int(p["y"] * frame_h)) for p in points]
        pts = np.array(pixel_pts, dtype=np.int32)
        cv2.polylines(frame, [pts], isClosed=True, color=color, thickness=2)
        cx = int(sum(p[0] for p in pixel_pts) / len(pixel_pts))
        cy = int(sum(p[1] for p in pixel_pts) / len(pixel_pts))
        cv2.putText(frame, f"region {region['id']} (street {region['street_id']})",
                    (cx, cy), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
    return frame


if __name__ == "__main__":
    main()
