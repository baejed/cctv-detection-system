from common.database import SessionLocal
from sqlalchemy import text
import threading

HEARTBEAT_INTERVAL_SEC = 4

class HeartbeatThread(threading.Thread):
    """
    Sends a heartbeat to the database every HEARTBEAT_INTERVAL_SEC.
    Also sets status = 'reconnecting' if the reader thread is no longer alive,
    catching crashes that bypass the normal reconnect_stream() flow.
    """

    def __init__(self, cctv_id: int, fps_ref: list, reader_thread: threading.Thread):
        super().__init__(daemon=True)
        self._cctv_id = cctv_id
        self._fps_ref = fps_ref
        self._reader_thread = reader_thread
        self._stop_event = threading.Event()

    def run(self):
        db = SessionLocal()
        try:
            while not self._stop_event.is_set():
                try:
                    db.execute(text("""
                        UPDATE worker_heartbeats
                        SET last_seen = NOW(),
                            frames_per_second = :fps,
                            status = CASE
                                WHEN :reader_alive = FALSE THEN 'reconnecting'
                                ELSE status
                            END
                        WHERE cctv_id = :cctv_id
                    """), {
                        "fps": self._fps_ref[0],
                        "reader_alive": self._reader_thread.is_alive(),
                        "cctv_id": self._cctv_id,
                    })
                    db.commit()
                except Exception as e:
                    print(f"[heartbeat cctv={self._cctv_id}] write failed: {e}")
                    try:
                        db.rollback()
                    except Exception:
                        pass
                    try:
                        db.close()
                    except Exception:
                        pass
                    db = SessionLocal()

                self._stop_event.wait(HEARTBEAT_INTERVAL_SEC)
        finally:
            db.close()

    def stop(self):
        self._stop_event.set()
