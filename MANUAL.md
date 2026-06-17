# EyeGila - System Manual

> Traffic detection and signal warrant analysis platform for Tagum City.  
> Last updated: 2026-06-16

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Development Setup](#3-development-setup)
4. [Production Setup](#4-production-setup)
5. [Services Reference](#5-services-reference)
6. [Configuration (Environment Variables)](#6-configuration-environment-variables)
7. [API Reference](#7-api-reference)
8. [Frontend Pages](#8-frontend-pages)
9. [Database Models](#9-database-models)
10. [Running Tests](#10-running-tests)
11. [Monitoring](#11-monitoring)
12. [Scripts & Tools](#12-scripts--tools)

---

## 1. Architecture Overview

```
RTSP Cameras
     │
     ▼
 ┌─────────┐   YOLO + ByteTrack   ┌─────────────┐
 │ worker  │ ───────────────────► │ TimescaleDB │
 │ (GPU /  │                      │  (PostgreSQL │
 │  CPU)   │                      │    + pgbouncer)
 └─────────┘                      └──────┬──────┘
                                         │
 ┌──────────┐  video jobs (RQ)           │
 │rq-worker │ ──────────────────────────►│
 └──────────┘                            │
                                         │
                                  ┌──────▼──────┐
                                  │   server    │
                                  │  (FastAPI)  │
                                  └──────┬──────┘
                                         │
                                  ┌──────▼──────┐
                                  │  frontend   │
                                  │  (React +   │
                                  │   Nginx)    │
                                  └─────────────┘
```

| Service | Role |
|---|---|
| `timescaledb` | TimescaleDB on PostgreSQL 16 - time-series detections and continuous aggregates |
| `pgbouncer` | Connection pooler in transaction mode - all services connect through it |
| `redis` | RQ job queue for video processing + SlowAPI rate-limit store |
| `server` | FastAPI REST API - CRUD, SSE live aggregation, MJPEG/WebSocket camera views, warrant analysis, signal timing |
| `rq-worker` | Processes uploaded video files (YOLO inference) asynchronously via RQ |
| `worker` | Live RTSP stream inference (CPU/Mac Dockerfile.mac or GPU Dockerfile) |
| `worker-gpu` | Same as `worker`, built for NVIDIA GPU with TensorRT cache |
| `frontend` | React + Vite dashboard served by Nginx |

### Data flow

1. **Live detection:** `worker` claims an RTSP camera via a DB-level optimistic lock, reads frames, runs YOLO, writes `detections` rows and `worker_heartbeats`.
2. **Aggregation:** A background task in `server` queries the `detection_street_view` view every 5 s and fans out to all SSE clients connected at `/aggregation/stream`.
3. **Video upload:** User uploads an MP4 → `rq-worker` runs YOLO frame-by-frame → stores detections tied to `video_id`.
4. **Warrant analysis:** `POST /recommendations/generate/{intersection_id}` reads the last 24 h of aggregated data, computes MUTCD warrants 1, 2, 4, runs a trained ML model, and writes a `recommendations` row plus per-TOD `timing_recommendations` and `simulation_results`.
5. **Signal timing:** Webster's formula on PCE-weighted flows per TOD chunk → green splits returned by `GET /timing-recommendations/{intersection_id}`.

---

## 2. Prerequisites

| Tool | Min version | Notes |
|---|---|---|
| Docker Engine | 24+ | With Compose v2 (`docker compose`) |
| Python | 3.11+ | For local tests and helper scripts only |
| Node.js | 18+ | Only for local frontend dev server |
| NVIDIA Container Toolkit | latest | GPU worker only |

---

## 3. Development Setup

### 3.1 Clone and copy env

```bash
git clone <repo> cctv-detection-system
cd cctv-detection-system
cp .env.example .env
```

Edit `.env` - the defaults work for local dev except for optional keys (VAPID, FERNET). The stack will start without them.

### 3.2 Start core services

```bash
# Core (DB, Redis, API server, RQ worker)
docker compose up -d

# Verify everything is healthy
docker compose ps
```

The server is now at `http://localhost:8000`.  
Interactive API docs: `http://localhost:8000/docs`

### 3.3 Create an admin user

```bash
docker compose run --rm setup-admin
# or run directly if server is up:
python scripts/setup_admin.py
```

Default credentials created by `setup_admin.py`: `admin` / `admin`.  
Change the password immediately after first login.

### 3.4 Start the frontend dev server

```bash
cd eyegila
npm install
npm run dev
```

Frontend is at `http://localhost:5173`. It proxies API calls to `http://localhost:8000`.

Alternatively, run the containerised frontend:

```bash
docker compose --profile frontend up -d frontend
```

Then visit `http://localhost:80`.

### 3.5 Start a camera worker

**CPU / Mac:**

```bash
docker compose --profile worker up -d worker
```

**NVIDIA GPU:**

```bash
docker compose --profile worker-gpu up -d worker-gpu worker-gpu-2
```

### 3.6 Seed fake data (no cameras needed)

```bash
# Seed intersections + fill 7 days of fake traffic
docker compose run --rm seeder
# or manually:
python scripts/fake_detections.py --full --days 7
```

### 3.7 Useful Makefile targets

```bash
make test-unit          # Fast unit tests, no server needed (~5 s)
make test               # All Python tests (needs docker compose up -d)
make test-integration   # Integration tests only
make test-frontend      # Vitest unit tests
make test-e2e           # Playwright E2E (needs docker compose up + npm run dev)
make test-load          # k6 load test (~90 s)
```

---

## 4. Production Setup

### 4.1 Generate secrets

```bash
cp .env.prod.example .env.prod
python scripts/generate_secrets.py >> .env.prod
```

Fill in `POSTGRES_PASSWORD`, `SUPER_KEY`, `FERNET_KEY`, `CORS_ORIGINS`, and optionally `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`.

**Generate VAPID keys (optional, for push notifications):**

```bash
npx web-push generate-vapid-keys
```

**Generate FERNET key (optional, encrypts RTSP URLs at rest):**

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

### 4.2 First run

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml run --rm setup-admin
```

Migrations run automatically on server startup via the `migrate` service (`alembic upgrade head`).

### 4.3 GPU worker (optional)

```bash
docker compose -f docker-compose.prod.yml --profile worker-gpu up -d
```

Remove or comment out `worker-gpu` from `docker-compose.prod.yml` if the server has no NVIDIA GPU.

### 4.4 Upgrade

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
# Migrations run automatically
```

### 4.5 Ports exposed in production

| Port | Service |
|---|---|
| `80` | Nginx → React frontend (also reverse-proxies `/api/*` → server) |
| `8000` | FastAPI server (internal only - not exposed to public in prod) |

In production the frontend Nginx container is the only public entry point. The server is accessed only through Docker's internal network.

---

## 5. Services Reference

### `timescaledb`

- Image: `timescale/timescaledb:latest-pg16`
- Database: `traffic` (dev) / `traffic` (prod)
- Port: `5433:5432` (dev), internal only (prod)
- Init script: `init.sql` - creates continuous aggregates (`detection_street_view`, `detection_by_region_view`) and TimescaleDB hypertables

### `pgbouncer`

- Pool mode: transaction
- Dev: `MAX_CLIENT_CONN=100`, `DEFAULT_POOL_SIZE=10`
- Prod: `MAX_CLIENT_CONN=200`, `DEFAULT_POOL_SIZE=20`
- All application services connect to `pgbouncer:5432`, never directly to `timescaledb`

### `redis`

- Image: `redis:7-alpine`
- Used for: RQ video job queue + SlowAPI rate-limit counters

### `server`

- FastAPI, Uvicorn
- Dev: single process with `--reload`
- Prod: 2 workers (`--workers 2`; increase if ≥4 CPU cores)
- Runs `alembic upgrade head` automatically in prod via the `migrate` service before starting
- Loads `server/ml/warrant_model.pt` + `warrant_scaler.pkl` on startup (warns and disables ML predictions if unavailable)
- Background tasks: `aggregation_pusher` (SSE fan-out every 5 s) + `analysis_loop` (auto-generates recommendations on a configurable interval)

### `rq-worker`

- Python RQ worker consuming the `video` queue
- Runs YOLO inference on uploaded video files
- Sends web push notifications on completion if VAPID keys are configured

### `worker` / `worker-gpu`

- Reads RTSP streams, runs YOLO + ByteTrack
- Claims cameras via optimistic DB lock (`worker_heartbeats`)
- `CAMERAS_PER_WORKER`: how many cameras each worker process handles (default 16 GPU, 1 CPU dev)
- `INFERENCE_EVERY_N`: run inference on every Nth frame (raise to reduce GPU/CPU load)
- `READER_MAX_FPS`: cap incoming frame rate (0 = unlimited)
- GPU variant uses TensorRT cache at `/app/trt_cache`

### `frontend`

- React + Vite, built into static files served by Nginx
- Nginx proxies `/api/*` → `server:8000` and `/ws/*` → `server:8000`

### `seeder` (tools profile)

- One-shot service: seeds 3 demo intersections with 4 streets and 4 cameras each, then inserts 7 days of realistic fake traffic data
- Run with `docker compose --profile tools run --rm seeder` or via `docker-compose.test.yml`

### `mediamtx` (tools profile)

- RTSP relay server for local development
- Port `8554` (RTSP), `1935` (RTMP)
- Useful when testing with OBS Studio or `ffmpeg` instead of real cameras

### `pgadmin` (tools profile)

- Web DB admin at `http://localhost:5050`
- Login: `admin@admin.com` / `admin`

### Monitoring (monitoring profile)

```bash
docker compose --profile monitoring up -d
```

- Prometheus at `http://localhost:9090` - scrapes `/metrics` (FastAPI) and `/metrics/workers` (heartbeat data)
- Grafana at `http://localhost:3000` - default dashboard: `monitoring/grafana/dashboards/worker-health.json`

---

## 6. Configuration (Environment Variables)

All variables have defaults that work for local development. Production requires the marked ones.

| Variable | Default | Prod required | Description |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@pgbouncer:5432/traffic` | yes | SQLAlchemy connection string |
| `REDIS_URL` | `redis://redis:6379` | yes | RQ + rate-limit |
| `POSTGRES_PASSWORD` | `postgres` | yes | TimescaleDB password (prod only) |
| `SUPER_KEY` | - | yes | Protects `POST/PUT/DELETE /users/*`; sent as `X-Super-Key` header |
| `FERNET_KEY` | - | recommended | Encrypts RTSP URLs at rest. Leave blank to skip encryption. Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | yes | Comma-separated allowed origins |
| `TZ` | `Asia/Manila` | | Server and worker timezone |
| `TRUST_PROXY_HEADERS` | `false` | yes (behind proxy) | Set `true` when behind Nginx/load balancer |
| `SESSION_TTL_HOURS` | `24` | | How long login tokens last |
| `MAX_UPLOAD_MB` | `500` | | Video upload size limit |
| `CAMERAS_PER_WORKER` | `16` (GPU) / `1` (CPU) | | Cameras per worker process |
| `INFERENCE_EVERY_N` | `1` | | Run YOLO on every Nth frame |
| `READER_MAX_FPS` | `0` | | Cap incoming frame rate (0 = unlimited) |
| `ANALYSIS_INTERVAL_MINUTES` | `0` (dev) / `60` (prod) | | Auto-regenerate recommendations interval; 0 = disabled |
| `VAPID_PUBLIC_KEY` | - | optional | Web push notification public key |
| `VAPID_PRIVATE_KEY` | - | optional | Web push notification private key |
| `PGBOUNCER_MAX_CLIENT_CONN` | `100` (dev) / `200` (prod) | | PgBouncer max connections |
| `PGBOUNCER_DEFAULT_POOL_SIZE` | `10` (dev) / `20` (prod) | | PgBouncer pool size |
| `GRAFANA_PASSWORD` | `admin` | | Grafana admin password |

---

## 7. API Reference

All endpoints require a `Bearer <token>` header except `/login` and `/health`.  
Interactive docs: `http://localhost:8000/docs`

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/login/` | Login - returns `{ token }`. Rate-limited: 10/minute. |
| `DELETE` | `/login/` | Logout - invalidates the current token. |

### Users (requires `X-Super-Key` header)

| Method | Path | Description |
|---|---|---|
| `POST` | `/users/` | Create a user |
| `GET` | `/users/` | List all users |
| `GET` | `/users/{user_id}` | Get a user |
| `PUT` | `/users/{user_id}` | Update username or password |
| `DELETE` | `/users/{user_id}` | Delete a user |

### Intersections

| Method | Path | Description |
|---|---|---|
| `POST` | `/intersections/` | Create intersection (auto-seeds 4 default TOD chunks) |
| `GET` | `/intersections/` | List all intersections |
| `GET` | `/intersections/{id}` | Get an intersection |
| `PUT` | `/intersections/{id}` | Full update |
| `PATCH` | `/intersections/{id}` | Partial update (name, lat/lng, crossing width) |
| `POST` | `/intersections/import` | Bulk CSV import (`intersection_name,latitude,longitude,camera_name,rtsp_url`) |
| `PATCH` | `/intersections/{id}/timing` | Set existing signal timing (cycle length + green splits) |
| `PATCH` | `/intersections/{id}/local-warrant-config` | Configure local warrant thresholds |
| `GET` | `/intersections/{id}/detect-timing` | Auto-detect cycle length from recent detections |
| `DELETE` | `/intersections/{id}` | Delete intersection and cascade all related data |

### Streets

| Method | Path | Description |
|---|---|---|
| `POST` | `/streets/` | Create street (tied to intersection, set arm direction N/S/E/W) |
| `GET` | `/streets/` | List streets |
| `GET` | `/streets/{id}` | Get a street |
| `PUT` | `/streets/{id}` | Update street name or direction |
| `DELETE` | `/streets/{id}` | Delete street |

### CCTVs

| Method | Path | Description |
|---|---|---|
| `POST` | `/cctvs/` | Add a camera |
| `GET` | `/cctvs/` | List cameras with live heartbeat status |
| `GET` | `/cctvs/{id}` | Get camera with live status |
| `PUT` | `/cctvs/{id}` | Update camera name, RTSP URL, or intersection |
| `DELETE` | `/cctvs/{id}` | Delete camera |
| `GET` | `/cctvs/discover` | WS-Discovery scan - finds ONVIF cameras on the local network (3 s UDP multicast). Rate-limited: 6/minute. |
| `POST` | `/cctvs/scan-nvr` | Probe an NVR's RTSP port and return channel URLs. Rate-limited: 10/minute. |

**Camera status values:** `online`, `reconnecting`, `offline`  
A camera is `offline` if no heartbeat received in the last 15 seconds.

### Camera Streams

| Method | Path | Description |
|---|---|---|
| `GET` | `/cctvs/{id}/stream` | MJPEG live stream (raw video, no overlays) |
| `GET` | `/cctvs/{id}/snapshot` | Single JPEG frame from Redis cache |
| `GET` | `/cctvs/{id}/boxes/stream` | MJPEG stream with detection bounding boxes overlaid |
| `WS` | `/cctvs/{id}/ws` | WebSocket: sends JPEG frames with box overlays + detection JSON |

All stream endpoints accept `?token=<jwt>` as an alternative to the `Authorization` header (needed for `<img src>` and `<video>` tags).

### Regions

| Method | Path | Description |
|---|---|---|
| `POST` | `/regions/` | Create a detection region polygon (linked to CCTV + street) |
| `GET` | `/regions/` | List regions |
| `GET` | `/regions/{id}` | Get a region |
| `PUT` | `/regions/{id}` | Update region points (normalized 0–1 coordinates) or direction |
| `DELETE` | `/regions/{id}` | Delete region |

### Detections

| Method | Path | Description |
|---|---|---|
| `GET` | `/detections/cctv/{cctv_id}` | Recent detections for a camera |
| `GET` | `/detections/region/{region_id}` | Recent detections for a region |

### Aggregation (SSE)

| Method | Path | Description |
|---|---|---|
| `GET` | `/aggregation/stream` | SSE stream - pushes JSON every 5 s with today's vehicle counts per intersection/street/direction/type |
| `GET` | `/aggregation/history` | Historical aggregation query (date range, intersection filter) |

SSE payload shape (one array of objects per push):

```json
[
  {
    "intersection_id": 1,
    "intersection_name": "City Hall",
    "street_id": 3,
    "direction": "northbound",
    "object_type": "motorcycle",
    "window_start": "2026-06-16T08:00:00",
    "count": 42
  }
]
```

### Recommendations (Warrant Analysis)

| Method | Path | Description |
|---|---|---|
| `GET` | `/recommendations/` | Latest recommendation for every intersection |
| `POST` | `/recommendations/generate/{intersection_id}` | Run warrant analysis + timing for one intersection |
| `POST` | `/recommendations/generate-all` | Run warrant analysis + timing for all intersections |
| `PATCH` | `/recommendations/{rec_id}/notes` | Save analyst notes on a recommendation |
| `GET` | `/recommendations/history/{intersection_id}` | All past recommendations for an intersection |
| `GET` | `/recommendations/data-health/{intersection_id}` | Data completeness report (hours of data, coverage) |

Warrants computed: **1** (minimum volume), **2** (interruption of continuous traffic), **4** (pedestrian volume). Also computes local warrants W1/W2/W3 with configurable thresholds per intersection.

### Signal Timing

| Method | Path | Description |
|---|---|---|
| `GET` | `/timing-recommendations/{intersection_id}` | Latest per-TOD-chunk timing (Webster's formula, PCE-weighted) |

Response includes `cycle_length`, `green_splits` per approach, `pce_tier_used`, and `signal_off` flag.

### Simulation

| Method | Path | Description |
|---|---|---|
| `GET` | `/simulation/{intersection_id}` | Latest before/after queue simulation results per TOD chunk |

Response includes `delay_before`, `delay_after`, LOS grades (A–F), V/C ratio, `vehicle_hours_saved`, and `queue_series_before/after` time series for animation.

### Time-of-Day (TOD) Chunks

| Method | Path | Description |
|---|---|---|
| `GET` | `/intersections/{id}/tod-chunks` | List TOD chunks for an intersection |
| `PUT` | `/intersections/{id}/tod-chunks/{chunk_id}` | Update a chunk's name and time range (HH:MM) |
| `GET` | `/intersections/{id}/tod-chunks/active` | Get the chunk active at a given `?ts=<ISO-8601>` timestamp |

Default TOD chunks seeded on intersection creation: Early Morning (00:00–06:00), AM Peak (06:00–09:00), Midday (09:00–15:00), PM Peak (15:00–18:00), Evening (18:00–21:00), Night (21:00–24:00).

### Passenger Car Equivalents (PCE)

| Method | Path | Description |
|---|---|---|
| `GET` | `/intersections/{id}/pce` | Resolved PCE values (default → calibrated → override priority) |
| `POST` | `/intersections/{id}/pce/overrides` | Set a manual PCE override for a vehicle type |
| `DELETE` | `/intersections/{id}/pce/overrides/{vehicle_type}` | Remove a PCE override |
| `POST` | `/intersections/{id}/pce/calibrate` | Calibrate PCE from the last 7 days of observed mix |

DPWH default PCE values: motorcycle 0.33, pedicab 0.50, tricycle 0.75, car 1.0, jeepney 1.5, bus 2.0, truck 2.0.

### Videos & Push Notifications

| Method | Path | Description |
|---|---|---|
| `POST` | `/videos/upload` | Upload a video file (MP4, AVI, MOV, MKV, M4V, WMV, FLV, WEBM). Returns `video_id` immediately; processing is async. Rate-limited: 20/minute. |
| `GET` | `/videos/{video_id}/status` | Poll processing status (`pending`, `processing`, `completed`, `failed`) |
| `GET` | `/videos` | List all videos with processing status |
| `GET` | `/videos/{video_id}/analytics` | Detection breakdown by vehicle type for a processed video |
| `GET` | `/push/vapid-public-key` | Returns the VAPID public key for browser subscription |
| `POST` | `/push/subscribe` | Register a browser push subscription |
| `DELETE` | `/push/subscribe` | Unregister a push subscription |

### Onboarding

| Method | Path | Description |
|---|---|---|
| `GET` | `/onboarding/progress` | Get the current user's wizard step |
| `PATCH` | `/onboarding/progress` | Update the user's wizard step (persisted server-side) |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness/readiness probe - `200 ok` or `503` if DB is unreachable |
| `GET` | `/metrics` | Prometheus metrics (FastAPI instrumentation) |
| `GET` | `/metrics/workers` | Worker heartbeat data as Prometheus gauge lines |

---

## 8. Frontend Pages

The app lives at `http://localhost:5173` (dev) or `http://localhost:80` (prod). All pages require login.

### Layout

A persistent sidebar with 4 main sections: **Dashboard**, **Intersections**, **Cameras**, and **Reports**. The sidebar also includes secondary links: Heatmap, Timing, Videos, Users, Manual.

The Layout component maintains a live SSE connection to `/aggregation/stream` and makes the `sseData` payload available to all pages via Outlet context.

### Dashboard (`/`)

Live traffic overview. Shows:
- Per-intersection vehicle/pedestrian counts from SSE data
- Bar chart of vehicle type mix for the selected intersection
- Active recommendation badge (signal warrant status)
- Toggle between **Grid** view (cards) and **Map** view (Leaflet CircleMarkers colored by traffic density)
- Density levels: None (gray) / Low <50 (green) / Moderate <150 (amber) / High <400 (orange) / Critical (red)

### Intersections (`/intersections`)

Manage intersections and cameras. Features:
- Grid or Map view of all intersections
- Create, edit, delete intersections with lat/lng
- CSV bulk import (template downloadable from UI)
- Per-intersection ONVIF discover + NVR scan via **IntersectionSetupWizard** modal
- Arm direction assignment per camera (N/S/E/W)
- Trigger warrant regeneration per intersection
- Live SSE vehicle counts per card
- Signal status badge per intersection

### Cameras (`/cameras`)

Manage cameras and bulk import. Features:
- List all cameras with live online/reconnecting/offline status
- Add, edit, delete cameras
- ONVIF WS-Discovery scan
- NVR channel scan (enter IP, credentials, max channels)
- CSV bulk import

### Camera Detail (`/cameras/:id`)

Per-camera management and live view. Features:
- Live MJPEG stream with detection box overlay (WebSocket-driven)
- Draw and edit detection region polygons (click-to-place normalized points)
- Assign each region to a street + direction
- Inline street name editing and direction assignment

### Heatmap (`/heatmap`)

Leaflet map with CircleMarkers per intersection colored and sized by current vehicle density (from SSE or last fetched aggregation). Click a marker to see a breakdown popup.

### Recommendations (`/recommendations`)

Warrant analysis results. Features:
- Table of latest recommendations per intersection with status badges
- Filter by status (Warranted / Borderline / Not warranted), warrant type (W1/W2/W4), minimum probability, text search
- Sort by any column
- **Regenerate** one or all intersections
- Detail side-sheet: warrant scores (W1/W2/W4 + local warrants), volumes, PHF, data age, notes editor
- Summary strip: count of warranted / borderline / not warranted intersections

**Status buckets:**

| Status | Condition |
|---|---|
| Warranted | `recommended = true` AND `recommended_confidence ≥ 0.7` |
| Borderline | `recommended = true` AND confidence < 0.7, OR any warrant met |
| Not Warranted | No warrants met |

### Signal Timing (`/timing/:intersection_id`)

Webster-formula timing for the selected intersection. Features:
- Per-TOD-chunk cycle length and green splits table
- Side-by-side Gantt phase comparison: **Current** (entered by engineer) vs **Recommended**
- Each Gantt shows green/amber/red bands per approach proportional to cycle length
- 2D animated intersection canvas and 3D Three.js scene (before/after queue simulation)
- **Present mode** - full-screen, hides all nav chrome for council screenshots
- Play/pause/scrub animation controls
- Vehicle-hours-saved summary

### Reports (`/reports`)

Historical aggregation charts. Features:
- Date range picker (Today, Yesterday, 7 days, 30 days, custom)
- Filter by intersection and street
- Vehicle count line chart over time
- Vehicle type breakdown bar chart
- Pedestrian count toggle
- CSV export of the current dataset

### Videos (`/videos`)

Upload and analyse recorded video files. Features:
- Drag-and-drop or file-picker upload (up to 500 MB, most video formats)
- Optional intersection assignment
- Real-time processing progress bar (polls `/videos/{id}/status`)
- Detection breakdown bar chart after processing

### Users (`/users`)

Admin-only user management (requires `SUPER_KEY`). Features:
- Enter admin key to authenticate
- Create, rename, reset password, delete users

### Manual (`/manual`)

Embedded in-app help guide with tabbed sections (Getting Started, Cameras, Regions, Analysis, Tips).

---

## 9. Database Models

All models live in `common/models.py`.

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `username`, `hash`, `role`, `wizard_step` | `role`: `viewer` or `admin`. `wizard_step` tracks onboarding per user. |
| `user_sessions` | `user_id`, `token_hash`, `expires_at` | SHA-256 hash of the opaque bearer token. |
| `intersections` | `id`, `name`, `latitude`, `longitude`, `signal_status`, `existing_cycle_length`, `existing_green_splits`, `lost_time_per_phase`, `all_red_clearance`, `min_cycle_length`, `max_cycle_length`, `crossing_width_m` | `signal_status`: `unsignalized`, `fixed_time`, `actuated`. |
| `streets` | `id`, `intersection_id`, `name`, `arm_direction` | `arm_direction`: `northbound`, `southbound`, `eastbound`, `westbound`, `unknown`. |
| `cctvs` | `id`, `intersection_id`, `name`, `rtsp_url`, `status` | `rtsp_url` is Fernet-encrypted at rest if `FERNET_KEY` is set. |
| `worker_heartbeats` | `cctv_id`, `worker_pid`, `last_seen`, `status`, `frames_per_second`, `last_error` | One row per camera. `status`: `running`, `reconnecting`. Camera is offline if `last_seen > 15 s` ago. |
| `regions` | `id`, `cctv_id`, `street_id`, `direction` | Polygon defining a counting zone on a camera frame. |
| `region_points` | `region_id`, `x`, `y` | Normalized coordinates (0.0–1.0). Stored as fractions, not pixels. |
| `detections` | `id` (BigInt), `cctv_id`, `video_id`, `track_id`, `object_type`, `confidence`, `x1/y1/x2/y2`, `time` | TimescaleDB hypertable. `cctv_id` and `video_id` are mutually exclusive (live vs uploaded). |
| `detections_in_regions` | `region_id`, `detection_id` | Maps each detection to which region polygons it fell inside. |
| `videos` | `id`, `intersection_id`, `filename`, `status`, `processed_frames`, `total_frames` | `status`: `pending`, `processing`, `completed`, `failed`. |
| `recommendations` | `id`, `intersection_id`, `warrant_1_met`, `warrant_2_met`, `warrant_4_met`, `recommended`, `recommended_confidence`, `major_volume`, `minor_volume`, `peds`, `vpm`, `phf`, `notes` | One per analysis run. Latest row is authoritative. |
| `timing_recommendations` | `id`, `intersection_id`, `recommendation_id`, `chunk_name`, `cycle_length`, `green_splits`, `pce_tier_used`, `signal_off` | One row per TOD chunk per recommendation. |
| `simulation_results` | `id`, `intersection_id`, `recommendation_id`, `chunk_name`, `delay_before`, `delay_after`, `vc_ratio_before`, `vc_ratio_after`, `vehicle_hours_saved`, `queue_series_before`, `queue_series_after` | Queue animation data per TOD chunk. |
| `tod_chunks` | `id`, `intersection_id`, `name`, `start_minutes`, `end_minutes` | Time stored as minutes from midnight (e.g. 360 = 06:00). |
| `pce_overrides` | `intersection_id`, `vehicle_type`, `pce_value` | Manual engineer-set PCE values. |
| `pce_calibrated_values` | `intersection_id`, `vehicle_type`, `pce_value` | Auto-calibrated from observed traffic mix. |
| `logs` | `id`, `message`, `time` | Audit log of all CRUD actions. |
| `push_subscriptions` | `user_id`, `endpoint`, `keys` | Web Push subscriptions per user. |

### Views (TimescaleDB continuous aggregates)

- `detection_street_view` - joins detections → regions → streets, bucketed by minute. Used by SSE aggregation.
- `detection_by_region_view` - similar aggregate keyed by region.

---

## 10. Running Tests

### Backend (pytest)

```bash
# Unit tests - no server needed, ~5 s
make test-unit
# or:
python3 -m pytest tests/test_stress.py tests/test_pedestrian_timing.py tests/test_cycle_detection.py -q

# All tests (integration tests auto-skip if server is unreachable)
make test
# or:
python3 -m pytest -q

# Integration tests only (server must be up)
make test-integration
```

Test files in `tests/`:

| File | What it tests |
|---|---|
| `test_auth.py` | Login, logout, token expiry, rate limits |
| `test_cameras.py` | CCTV CRUD, ONVIF discovery endpoint |
| `test_intersections.py` | Intersection CRUD, CSV import, timing patch |
| `test_health.py` | `/health` endpoint |
| `test_aggregation.py` | SSE stream connection, history query |
| `test_recommendations.py` | Warrant generation, history, data health |
| `test_simulation.py` | Simulation results after warrant generation |
| `test_timing.py` | Timing recommendations per TOD chunk |
| `test_tod.py` | TOD chunk CRUD and active-chunk lookup |
| `test_pce.py` | PCE resolve, override, calibrate |
| `test_onboarding.py` | Onboarding wizard progress API |
| `test_integration_extended.py` | End-to-end data pipeline (detection → aggregation → recommendation) |
| `test_stress.py` | Webster formula edge cases (unit, no server needed) |
| `test_pedestrian_timing.py` | Pedestrian crossing time calculation (unit) |
| `test_cycle_detection.py` | Signal cycle auto-detection (unit) |
| `test_arm_direction.py` | Arm direction mapping (unit) |
| `test_local_warrants.py` | Local warrant threshold logic (unit) |
| `test_worker_claim.py` | Worker DB-level camera claim concurrency (unit) |

**pytest.ini** marks: `ratelimit` tests are excluded by default (they exhaust the login rate limit). Run with `-m ratelimit` explicitly.

**Integration test env vars** (set automatically by `docker-compose.test.yml`):

```
API_URL=http://server:8000
DATABASE_URL=postgresql://postgres:postgres@timescaledb:5432/traffic_test
ADMIN_USER=admin
ADMIN_PASS=admin
```

### Frontend unit tests (Vitest)

```bash
make test-frontend
# or:
cd eyegila && npm test
```

### Playwright E2E

Needs the full stack running (server + frontend):

```bash
make test-e2e
# or:
cd eyegila && npx playwright test --config e2e/playwright.config.ts
```

With UI / headed mode:

```bash
cd eyegila && npx playwright test --headed
cd eyegila && npx playwright test --ui
```

**Config (`eyegila/e2e/playwright.config.ts`):**
- Browser: Chromium only
- Base URL: `http://localhost:5173` (override with `BASE_URL` env var)
- Tests run sequentially (share auth state)
- Retries: 1
- Timeout: 30 s
- Traces and screenshots on failure

### Full E2E test suite (Docker, isolated)

Spins up a completely separate Docker network (`eyegila-test`), seeds data, runs pytest + Playwright, then tears everything down:

```bash
./scripts/run-tests.sh              # run everything
./scripts/run-tests.sh --no-build   # skip rebuild (use cached images)
./scripts/run-tests.sh --pytest     # backend tests only
./scripts/run-tests.sh --playwright # E2E tests only
```

Playwright report is copied to `test-results/playwright/` on completion.

### Load test (k6)

```bash
make test-load
# or:
k6 run k6/stress.js
```

Requires `k6` installed (`sudo apt-get install k6`). Duration ~90 s. Server must be running at `http://localhost:8000`.

---

## 11. Monitoring

Start the monitoring stack:

```bash
docker compose --profile monitoring up -d
```

### Prometheus

- URL: `http://localhost:9090`
- Scrapes:
  - `/metrics` (FastAPI auto-instrumentation) every 15 s
  - `/metrics/workers` (worker heartbeat gauges) every 10 s
- Custom metrics:
  - `worker_camera_fps{cctv_id, cctv_name}` - frames per second reported by the worker
  - `worker_camera_claimed{cctv_id, cctv_name}` - 1 if a worker currently owns the camera

### Grafana

- URL: `http://localhost:3000`
- Default login: `admin` / `admin` (change via `GRAFANA_PASSWORD` env var)
- Pre-provisioned dashboard: **Worker Health** - shows per-camera FPS and claim status

---

## 12. Scripts & Tools

### `scripts/fake_detections.py`

Inserts realistic fake traffic data for testing.

```bash
# Seed 3 demo intersections + fill 7 days of traffic
python scripts/fake_detections.py --full

# Seed intersections only (skip if already exist)
python scripts/fake_detections.py --seed

# Fill all cameras with N days of data
python scripts/fake_detections.py --fill --days 14

# Fill a specific camera/region
python scripts/fake_detections.py --cctv-id 1 --region-id 1 --count 500 --hours 2

# List what's in the database
python scripts/fake_detections.py --list
```

The seeder creates: City Hall Intersection, Osmena Park, Rotunda - each with 4 streets (N/S/E/W) and 4 cameras. Traffic patterns follow realistic time-of-day curves with AM/PM peaks. Vehicle mix for Tagum City context: motorcycles 50%, tricycles/pedicabs heavy, cars, trucks.

### `scripts/setup_admin.py`

Creates the initial `admin` / `admin` user. Safe to run after the DB is up.

```bash
python scripts/setup_admin.py
# or via Docker:
docker compose run --rm setup-admin
```

### `scripts/generate_secrets.py`

Generates `SUPER_KEY`, `FERNET_KEY`, and `POSTGRES_PASSWORD` and prints them to stdout for appending to `.env.prod`.

```bash
python scripts/generate_secrets.py >> .env.prod
```

### `scripts/run-tests.sh`

Full-stack E2E test runner. See [§10 Running Tests](#10-running-tests).

### `afk-ralph.sh`

AFK batch runner - runs Claude Code in a loop N times, implementing one PRD task per iteration. Used for autonomous development sessions.

```bash
./afk-ralph.sh 10
```

### `ralph-once.sh`

Single-run version of `afk-ralph.sh`. Runs Claude Code once against `onboarding-issues.md`.

### `k6/stress.js`

Load test script. Simulates concurrent logins, aggregation stream connections, and warrant generation. Run with `k6 run k6/stress.js`.

### `alembic` (DB migrations)

```bash
# Apply all pending migrations
alembic upgrade head

# Create a new migration
alembic revision --autogenerate -m "description"

# Roll back one step
alembic downgrade -1
```

In production, migrations run automatically as the `migrate` service on every `docker compose up`.

### Seeder container

```bash
# Run in dev stack
docker compose --profile tools run --rm seeder

# Run in test stack (done automatically by run-tests.sh)
docker compose -f docker-compose.test.yml run --rm seeder
```
