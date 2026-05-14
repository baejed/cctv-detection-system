# EyeGila – CCTV Traffic Detection System

A full-stack traffic monitoring platform that ingests live RTSP camera streams, runs real-time object detection and tracking, and provides a web dashboard with traffic signal warrant analysis.

---

## Architecture

```
Cameras (RTSP)
    │
    ▼
[Worker]  ──── YOLO + ByteTrack ────►  TimescaleDB  ◄──── [RQ Worker]
(claims cameras via DB lock)           (detections,         (video uploads)
                                        aggregations)
                                            │
                                        [Server]  (FastAPI)
                                            │
                                        [Nginx]  ──► [Frontend] (React)
```

| Service | Role |
|---------|------|
| `timescaledb` | TimescaleDB (PostgreSQL 16) — time-series detections + continuous aggregates |
| `pgbouncer` | Connection pooler (transaction mode) |
| `redis` | RQ job queue + rate-limit store |
| `server` | FastAPI REST API — CRUD, MJPEG live view, warrant analysis |
| `rq-worker` | Processes uploaded video files asynchronously |
| `worker` | Live RTSP inference (CPU/Mac profile) |
| `worker-gpu` | Live RTSP inference (NVIDIA GPU, production) |
| `frontend` | React dashboard served by Nginx |

---

## Quick Start

```bash
git clone <repo> cctv-detection-system
cd cctv-detection-system

# Create .env (see SETUP.md for all variables)
cp .env.example .env   # or create manually

# Start core services (DB + API)
docker compose up -d

# Start the frontend
docker compose --profile frontend up -d frontend

# Start the worker (CPU/Mac)
docker compose --profile worker up -d worker
```

See **[SETUP.md](SETUP.md)** for the full setup walkthrough including VAPID keys, seed data, test streams, and production k3s deployment.

---

## Tech Stack

**Backend** — Python 3.11, FastAPI, SQLAlchemy, PgBouncer, TimescaleDB, Redis, RQ

**Worker** — YOLO (Ultralytics), ByteTrack, OpenCV, TensorRT (GPU build)

**Frontend** — React, TypeScript, Vite, Tailwind CSS, shadcn/ui

**Infra** — Docker Compose (dev), k3s (production), Prometheus + Grafana (monitoring)

---

## Project Structure

```
common/          Shared SQLAlchemy models and DB session
server/          FastAPI app — routers, schemas, ML inference, MJPEG
  ml/            Warrant model (scikit-learn + PyTorch)
  routers/       cctv, intersection, street, region, detection,
                 recommendations, aggregation, mjpeg, videos …
worker/          Live RTSP inference pipeline
  main.py        Camera slot manager + YOLO batch inference loop
  claim.py       Atomic camera claiming (FOR UPDATE SKIP LOCKED)
  heartbeat.py   HeartbeatThread — keeps DB lock alive
  stream.py      RTSP open / reconnect with exponential backoff
rq-worker/       Video file processing jobs
eyegila/         React frontend (Vite + Nginx)
tests/           Integration tests (run against live stack)
k3s/             Kubernetes manifests for production
monitoring/      Prometheus + Grafana dashboards
```

---

## Camera Claiming

Each worker process atomically claims cameras from the database using `SELECT … FOR UPDATE SKIP LOCKED`. It maintains a heartbeat row in `worker_heartbeats` (updated every 4 s). The API derives camera status from heartbeat freshness — any camera whose heartbeat is older than 15 s shows as **offline**.

```
CAMERAS_PER_WORKER=2   # how many cameras one worker process handles
INFERENCE_EVERY_N=1    # run inference on every Nth frame
```

Set these in `.env` at the repo root.

---

## Warrant Analysis

The **Recommendations** page runs an ML model (warrant\_model.pt) against the last hour of aggregated traffic data to evaluate MUTCD traffic signal warrants (W1 volume, W2 interruption, W4 pedestrian). Results are stored in the `recommendations` table and surfaced on the dashboard.

---

## Development Workflow

Source directories are bind-mounted into containers so code changes take effect without rebuilding:

```bash
# Server (FastAPI) — auto-reloads on file save via --reload
# No action needed after editing server/ or common/

# Worker — restart to pick up changes
docker compose --profile worker restart worker

# Frontend — use Vite dev server for hot-reload
cd eyegila && npm run dev   # http://localhost:5173

# Only rebuild when requirements.txt changes
docker compose build server
```

---

## Running Tests

Tests hit the live stack directly (requires `docker compose up`):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-test.txt
pytest
```

---

## API Docs

Available at **http://localhost:8000/docs** (Swagger) and **/redoc** when the stack is running.
