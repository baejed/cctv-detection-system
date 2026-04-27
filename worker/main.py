from common.models import CCTV, Region, Detection, DetectionInRegion
from common.database import Base, SessionLocal, engine
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, update
from dataclasses import dataclass, field
from sqlalchemy.orm import Session
from typing import Set, Optional
from ultralytics import YOLO
import logging
import uuid
import time
import cv2

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL_SEC = 30
CLAIM_TIMEOUT_SEC = 60
POLL_INTERVAL_SEC = 15
PRUNE_INTERVAL_SEC = 10
TRACK_MAX_AGE_SEC = 30
# After this many consecutive failed reads (~10s), reopen the RTSP connection.
RTSP_FAIL_THRESHOLD = 100


@dataclass
class TrackState:
    track_id: int
    cls_name: str
    db_detection_id: Optional[int] = None
    regions_entered: Set[int] = field(default_factory=set)
    last_seen_ts: float = field(default_factory=time.time)


def claim_camera(db: Session, worker_id: str) -> Optional[tuple[int, str]]:
    stale_cutoff = datetime.now(timezone.utc) - timedelta(seconds=CLAIM_TIMEOUT_SEC)
    cctv = db.execute(
        select(CCTV)
        .where((CCTV.worker_id.is_(None)) | (CCTV.claimed_at < stale_cutoff))
        .limit(1)
        .with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if cctv is None:
        return None
    cctv.worker_id = worker_id
    cctv.claimed_at = datetime.now(timezone.utc)
    db.commit()
    logger.info(f"Claimed camera {cctv.id} ({cctv.name})")
    return cctv.id, cctv.rtsp_url


def release_camera(db: Session, cctv_id: int, worker_id: str) -> None:
    db.execute(
        update(CCTV)
        .where(CCTV.id == cctv_id, CCTV.worker_id == worker_id)
        .values(worker_id=None, claimed_at=None)
    )
    db.commit()
    logger.info(f"Released camera {cctv_id}")


def send_heartbeat(db: Session, cctv_id: int, worker_id: str) -> bool:
    """Returns False if the camera was deleted or claimed by another worker."""
    db.expire_all()
    cctv = db.get(CCTV, cctv_id)
    if cctv is None or cctv.worker_id != worker_id:
        return False
    cctv.claimed_at = datetime.now(timezone.utc)
    db.commit()
    return True


def process_camera(
    db: Session,
    model: YOLO,
    worker_id: str,
    cctv_id: int,
    rtsp_url: str,
    debug: bool,
) -> None:
    cap = cv2.VideoCapture(2 if debug else rtsp_url)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    regions = initialize_regions(db, cctv_id)
    track_states: dict[int, TrackState] = {}
    last_prune_ts = time.time()
    last_heartbeat_ts = time.time()
    consecutive_failures = 0

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                consecutive_failures += 1
                time.sleep(0.1)
                if consecutive_failures >= RTSP_FAIL_THRESHOLD:
                    logger.warning(f"Camera {cctv_id}: stream unresponsive, reconnecting...")
                    cap.release()
                    cap = cv2.VideoCapture(rtsp_url)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    consecutive_failures = 0
                continue
            consecutive_failures = 0

            results = model.track(frame, persist=True)

            if debug:
                cv2.imshow("frame", results[0].plot())
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            for box in results[0].boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cls_id = int(box.cls[0])
                cls_name = model.names[cls_id]
                track_id = int(box.id[0]) if box.id is not None else None
                if track_id is None:
                    continue
                process_detection(db, regions, track_states, track_id, cls_name, (x1, y1, x2, y2), cctv_id)

            now = time.time()

            if now - last_prune_ts > PRUNE_INTERVAL_SEC:
                prune_tracks(track_states, max_age_seconds=TRACK_MAX_AGE_SEC)
                last_prune_ts = now

            if now - last_heartbeat_ts > HEARTBEAT_INTERVAL_SEC:
                if not send_heartbeat(db, cctv_id, worker_id):
                    logger.info(f"Camera {cctv_id} removed or reclaimed — releasing")
                    return
                # Reload regions so edits made via UI take effect without restart.
                regions = initialize_regions(db, cctv_id)
                last_heartbeat_ts = now
    finally:
        cap.release()
        if debug:
            cv2.destroyAllWindows()
        release_camera(db, cctv_id, worker_id)


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    worker_id = str(uuid.uuid4())
    logger.info(f"Worker started id={worker_id}")
    model = YOLO("yolov8s.pt")

    while True:
        db = SessionLocal()
        try:
            result = claim_camera(db, worker_id)
            if result is None:
                logger.info("No cameras available, polling...")
                time.sleep(POLL_INTERVAL_SEC)
                continue
            cctv_id, rtsp_url = result
            process_camera(db, model, worker_id, cctv_id, rtsp_url, debug=args.debug)
        except Exception:
            logger.exception("Worker error, retrying in 5s")
            time.sleep(5)
        finally:
            try:
                db.close()
            except Exception:
                pass


def initialize_regions(db: Session, cctv_id: int) -> list[dict]:
    regions = []
    db_regions = db.query(Region).filter(Region.cctv_id == cctv_id).all()
    for db_region in db_regions:
        region = {
            "id": db_region.id,
            "street_id": db_region.street_id,
            "region_points": [
                {"id": p.id, "x": p.x, "y": p.y}
                for p in db_region.region_points
            ],
        }
        regions.append(region)
    return regions


def process_detection(
    db: Session,
    regions: list[dict],
    track_states: dict[int, TrackState],
    track_id: int,
    cls_name: str,
    bounding_box: tuple[int, int, int, int],
    cctv_id: int,
) -> None:
    center = get_center(bounding_box)

    if track_id not in track_states:
        track_states[track_id] = TrackState(track_id=track_id, cls_name=cls_name)

    state = track_states[track_id]
    state.last_seen_ts = time.time()

    if state.db_detection_id is None:
        detection = Detection(cctv_id=cctv_id, type=cls_name)
        db.add(detection)
        try:
            db.commit()
            db.refresh(detection)
            state.db_detection_id = detection.id
        except Exception:
            db.rollback()
            return

    for region in regions:
        region_id = region["id"]
        polygon = [(p["x"], p["y"]) for p in region["region_points"]]
        if is_point_in_polygon(center, polygon) and region_id not in state.regions_entered:
            state.regions_entered.add(region_id)
            dir_entry = DetectionInRegion(region_id=region_id, detection_id=state.db_detection_id)
            db.add(dir_entry)
            try:
                db.commit()
            except Exception:
                db.rollback()


def prune_tracks(track_states: dict[int, TrackState], max_age_seconds: float) -> None:
    now = time.time()
    stale = [tid for tid, s in track_states.items() if now - s.last_seen_ts > max_age_seconds]
    for tid in stale:
        del track_states[tid]


def get_center(bounding_box: tuple[int, int, int, int]) -> tuple[float, float]:
    x1, y1, x2, y2 = bounding_box
    return ((x1 + x2) / 2, (y1 + y2) / 2)


def is_point_in_polygon(point: tuple[float, float], polygon: list[tuple[int, int]]) -> bool:
    x, y = point
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            x_intersect = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < x_intersect:
                inside = not inside
    return inside


if __name__ == "__main__":
    main()
