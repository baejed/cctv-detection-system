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
from sqlalchemy import text

from common.database import engine, Base, SessionLocal
from server.routers.aggregation import router as aggregation_router, aggregation_pusher
from server.routers.videos import router as videos_router
from server.routers.recommendations import router as recommendations_router
from server.routers.mjpeg import router as mjpeg_router
from server.routers.camera_ws import router as camera_ws_router
from server.routers import user, login, intersection, street, cctv, detection, region

load_dotenv()

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        try:
            db.execute(text(
                "ALTER TABLE worker_heartbeats ADD COLUMN IF NOT EXISTS last_error VARCHAR(500)"
            ))
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
            db.commit()
        except Exception:
            db.rollback()
    from pathlib import Path
    from server.ml.inference import load_warrant_model
    ml_dir = Path(__file__).resolve().parent / "ml"
    app.state.warrant_artifacts = load_warrant_model(
        ml_dir / "warrant_model.pt",
        ml_dir / "warrant_scaler.pkl",
    )
    task = asyncio.create_task(aggregation_pusher())
    yield
    task.cancel()


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
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _CORS_ORIGINS],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health", include_in_schema=False)
def health():
    """Liveness/readiness probe — returns 503 if DB is unreachable."""
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
    """Expose worker heartbeat data as Prometheus gauge lines."""
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
