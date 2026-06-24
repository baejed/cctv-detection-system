from contextlib import asynccontextmanager
import asyncio
import json
import logging
import os

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from server.rate_limit import limiter
from dotenv import load_dotenv
from prometheus_client import (
    CollectorRegistry, Counter, Gauge, generate_latest,
    CONTENT_TYPE_LATEST, REGISTRY,
)
from prometheus_fastapi_instrumentator import Instrumentator
import prometheus_fastapi_instrumentator.routing as _pfi_routing

# Patch: _IncludedRouter has no `path` attr - guard against it
_orig_get_route_name = _pfi_routing._get_route_name
def _safe_get_route_name(scope, routes):
    safe = [r for r in routes if hasattr(r, "path")]
    return _orig_get_route_name(scope, safe)
_pfi_routing._get_route_name = _safe_get_route_name
from sqlalchemy import text

from common.database import engine, Base, SessionLocal
from server.routers.aggregation import router as aggregation_router, aggregation_pusher
from server.routers.videos import router as videos_router
from server.routers.recommendations import router as recommendations_router
from server.routers.mjpeg import router as mjpeg_router
from server.routers.camera_ws import router as camera_ws_router
from server.routers import user, login, intersection, street, cctv, detection, region
from server.routers.pce import router as pce_router
from server.routers.tod import router as tod_router
from server.routers.timing import router as timing_router
from server.routers.simulation import router as simulation_router
from server.routers.onboarding import router as onboarding_router

load_dotenv()

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        try:
            # Guard every DDL statement with an existence check via information_schema
            # so that ALTER TABLE (which acquires AccessExclusiveLock even with
            # IF NOT EXISTS) is never executed on a post-migration startup.
            # This makes the hot-restart path completely lock-free.
            def col_exists(table: str, col: str) -> bool:
                return bool(db.execute(text(
                    "SELECT 1 FROM information_schema.columns "
                    "WHERE table_name = :t AND column_name = :c"
                ), {"t": table, "c": col}).scalar())

            if not col_exists("worker_heartbeats", "last_error"):
                db.execute(text(
                    "ALTER TABLE worker_heartbeats ADD COLUMN last_error VARCHAR(500)"
                ))

            rec_cols = [
                "recommended_confidence", "major_volume", "minor_volume",
                "peds", "vpm", "phf", "hour_start",
            ]
            if any(not col_exists("recommendations", c) for c in rec_cols):
                db.execute(text("""
                    ALTER TABLE recommendations
                        ADD COLUMN IF NOT EXISTS recommended_confidence FLOAT,
                        ADD COLUMN IF NOT EXISTS major_volume INTEGER,
                        ADD COLUMN IF NOT EXISTS minor_volume INTEGER,
                        ADD COLUMN IF NOT EXISTS peds INTEGER,
                        ADD COLUMN IF NOT EXISTS vpm INTEGER,
                        ADD COLUMN IF NOT EXISTS phf FLOAT,
                        ADD COLUMN IF NOT EXISTS hour_start TIMESTAMPTZ
                """))

            # Drop NOT NULL from cctv_id only if the column is still non-nullable.
            is_not_null = db.execute(text(
                "SELECT a.attnotnull FROM pg_attribute a "
                "JOIN pg_class c ON c.oid = a.attrelid "
                "WHERE c.relname = 'detections' AND a.attname = 'cctv_id'"
            )).scalar()
            if is_not_null:
                db.execute(text(
                    "ALTER TABLE detections ALTER COLUMN cctv_id DROP NOT NULL"
                ))

            db.commit()
        except Exception:
            db.rollback()
    from pathlib import Path
    ml_dir = Path(__file__).resolve().parent / "ml"
    try:
        from server.ml.inference import load_warrant_model
        app.state.warrant_artifacts = load_warrant_model(
            ml_dir / "warrant_model.pt",
            ml_dir / "warrant_scaler.pkl",
        )
    except Exception as exc:
        logging.warning("Warrant model unavailable, predictions disabled: %s", exc)
        app.state.warrant_artifacts = None
    try:
        from server.ml.temporal_inference import load_recommender
        recommender_path = Path(
            os.getenv("TEMPORAL_CNN_MODEL_PATH", str(ml_dir / "temporal_cnn_model.pt"))
        )
        app.state.recommender_artifacts = load_recommender(recommender_path)
    except Exception as exc:
        logging.warning(
            "Recommender model unavailable, falling back to warrant baseline: %s", exc,
        )
        app.state.recommender_artifacts = None
    from server.scheduler import analysis_loop
    task_agg      = asyncio.create_task(aggregation_pusher())
    task_analysis = asyncio.create_task(analysis_loop(app))
    yield
    task_agg.cancel()
    task_analysis.cancel()


app = FastAPI(lifespan=lifespan)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)

# Allow the Vite dev server and any production origin to call the API directly
# (needed for SSE EventSource and WebSocket which browsers send with Origin headers)
_CORS_ORIGINS = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173",
).split(",")
_is_dev = os.getenv("ENVIRONMENT", "production").lower() in ("dev", "development", "local")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _CORS_ORIGINS],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+" if _is_dev else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health", include_in_schema=False)
def health():
    """Liveness/readiness probe - returns 503 if DB is unreachable."""
    try:
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        db.close()
        return {"status": "ok"}
    except Exception as exc:
        return Response(
            content=json.dumps({"status": "error", "detail": str(exc)}),
            status_code=503,
            media_type="application/json",
        )


@app.get("/metrics/workers", include_in_schema=False)
def worker_metrics():
    """Expose worker heartbeat data as Prometheus gauge lines.

    Also emits three fleet-level scalar gauges the worker HPA scales on:
      eyegila_cameras_total      - every camera row in the DB
      eyegila_cameras_claimed    - cameras with a worker heartbeat ≤15 s old
      eyegila_cameras_unclaimed  - the gap (total − claimed); scale-up signal

    The 15 s window matches worker/claim.py:CLAIM_EXPIRY_SEC, so a camera
    only counts as "claimed" if its assigned worker is actually still
    publishing heartbeats. A dead-but-not-yet-evicted worker stops protecting
    its claim within 15 s, which becomes unclaimed load that HPA reacts to.
    """
    db = SessionLocal()
    lines: list[str] = []
    try:
        rows = db.execute(text(
            "SELECT c.id, c.name, h.frames_per_second, h.status, h.last_seen "
            "FROM cctvs c LEFT JOIN worker_heartbeats h ON h.cctv_id = c.id"
        )).fetchall()
        lines.append("# HELP worker_camera_fps Frames per second reported by worker heartbeat")
        lines.append("# TYPE worker_camera_fps gauge")
        lines.append("# HELP worker_camera_claimed 1 if a worker currently owns this camera")
        lines.append("# TYPE worker_camera_claimed gauge")
        for r in rows:
            lbl = f'cctv_id="{r.id}",cctv_name="{r.name}"'
            fps = r.frames_per_second if r.frames_per_second is not None else 0
            claimed = 1 if r.status is not None else 0
            lines.append(f"worker_camera_fps{{{lbl}}} {fps}")
            lines.append(f"worker_camera_claimed{{{lbl}}} {claimed}")

        fleet = db.execute(text("""
            SELECT
                (SELECT COUNT(*)::int FROM cctvs) AS total,
                (SELECT COUNT(*)::int FROM worker_heartbeats
                  WHERE last_seen > NOW() - INTERVAL '15 seconds') AS claimed
        """)).fetchone()
        total = int(fleet.total)
        claimed = int(fleet.claimed)
        unclaimed = max(0, total - claimed)
        lines.append("# HELP eyegila_cameras_total Total cameras configured in the system")
        lines.append("# TYPE eyegila_cameras_total gauge")
        lines.append(f"eyegila_cameras_total {total}")
        lines.append("# HELP eyegila_cameras_claimed Cameras with a live worker heartbeat (≤15s)")
        lines.append("# TYPE eyegila_cameras_claimed gauge")
        lines.append(f"eyegila_cameras_claimed {claimed}")
        lines.append("# HELP eyegila_cameras_unclaimed Cameras without a live worker - HPA scales on this")
        lines.append("# TYPE eyegila_cameras_unclaimed gauge")
        lines.append(f"eyegila_cameras_unclaimed {unclaimed}")
    finally:
        db.close()
    return PlainTextResponse("\n".join(lines) + "\n", media_type=CONTENT_TYPE_LATEST)


app.include_router(aggregation_router)
app.include_router(recommendations_router)
app.include_router(mjpeg_router)
app.include_router(camera_ws_router)
app.include_router(user.router)
app.include_router(login.router)
app.include_router(intersection.router)
app.include_router(videos_router)
app.include_router(street.router)
app.include_router(cctv.router)
app.include_router(detection.router)
app.include_router(region.router)
app.include_router(pce_router)
app.include_router(tod_router)
app.include_router(timing_router)
app.include_router(simulation_router)
app.include_router(onboarding_router)
