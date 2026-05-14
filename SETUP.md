# EyeGila – Setup Guide

Step-by-step instructions for running the full system on a new machine.

---

## Prerequisites

| Tool | Minimum version | Notes |
|------|----------------|-------|
| Docker Desktop / Docker Engine | 24+ | With Docker Compose v2 |
| Python | 3.11+ | For scripts and tests (not needed for the containers) |
| Git | any | |
| OBS Studio | any | For test RTSP streams (optional in prod) |

> Node.js is only needed if you want to run the frontend dev server locally (`npm run dev`). The Docker Compose stack builds and serves the frontend automatically.

---

## 1. Clone the repo

```bash
git clone <your-repo-url> cctv-detection-system
cd cctv-detection-system
```

---

## 2. Generate VAPID keys

Web Push notifications require a VAPID key pair. Generate them **once** and store them securely.

```bash
pip install py-vapid
vapid --gen
```

This outputs `private_key.pem` and `public_key.pem`. The values you need are:

- **VAPID_PRIVATE_KEY** – the PEM file contents (the full `-----BEGIN EC PRIVATE KEY-----` block)
- **VAPID_PUBLIC_KEY** – the uncompressed base64url public key (starts with `BP…`)

To extract them programmatically:

```bash
python3 - <<'EOF'
from py_vapid import Vapid
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption, PublicFormat
v = Vapid.from_file("private_key.pem")
print("VAPID_PRIVATE_KEY =", v.private_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode().strip())
print("VAPID_PUBLIC_KEY  =", v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint).hex())
EOF
```

---

## 3. Create the `.env` file

Create `.env` in the project root (it is gitignored):

```env
# Required
VAPID_PRIVATE_KEY=<your-private-key-here>
VAPID_PUBLIC_KEY=<your-public-key-here>

# Optional — defaults shown
TZ=Asia/Manila
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173

# Optional — encrypt RTSP URLs at rest in the database
# Generate with: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# FERNET_KEY=<base64-fernet-key>

# Optional — override how many cameras each worker handles and inference rate
# CAMERAS_PER_WORKER=16
# INFERENCE_EVERY_N=1
```

The Docker Compose file reads these variables and injects them into the appropriate containers.

---

## 4. Start all services

Services are split into Docker Compose profiles. Start what you need:

```bash
# Core (DB + API) — always needed
docker compose up --build -d

# Frontend (Nginx serving the React app)
docker compose --profile frontend up -d frontend

# Worker — CPU/Mac (no GPU required)
docker compose --profile worker up -d worker

# Worker — NVIDIA GPU (production)
docker compose --profile worker-gpu up -d worker-gpu worker-gpu-2

# Optional tooling
docker compose --profile tools up -d pgadmin mediamtx

# Monitoring (Prometheus + Grafana)
docker compose --profile monitoring up -d prometheus grafana
```

| Container | Profile | Port (host) | Purpose |
|-----------|---------|------------|---------|
| `timescaledb` | _(default)_ | 5433 | TimescaleDB (PostgreSQL 16) |
| `pgbouncer` | _(default)_ | 5432 | Connection pool |
| `redis` | _(default)_ | 6379 | Job queue + rate-limit store |
| `rq-worker` | _(default)_ | — | Processes uploaded video files |
| `server` | _(default)_ | 8000 | FastAPI backend |
| `frontend` | `frontend` | **80** | React dashboard (Nginx) |
| `worker` | `worker` | — | Live RTSP inference (CPU/Mac) |
| `worker-gpu` | `worker-gpu` | — | Live RTSP inference (NVIDIA GPU) |
| `pgadmin` | `tools` | 5050 | DB admin UI (admin@admin.com / admin) |
| `mediamtx` | `tools` | 8554/1935 | Test RTSP server |
| `prometheus` | `monitoring` | 9090 | Metrics scraper |
| `grafana` | `monitoring` | 3000 | Dashboards |

The database is initialized automatically from `init.sql` the first time `timescaledb` starts with a fresh volume — tables, hypertable, continuous aggregate, indexes, and a default admin user are all created.

Wait for all services to be healthy:

```bash
docker compose ps
```

All containers should show `healthy` or `running`.

---

## 5. Verify everything is up

| URL | What to expect |
|-----|---------------|
| `http://localhost` | EyeGila login page |
| `http://localhost/api/health` | `{"status":"ok"}` |
| `http://localhost:8000/docs` | FastAPI Swagger UI |

Default credentials: **admin / admin** (set in `init.sql`). Change on first login via `/users`.

---

## 6. Seed test data

For a clean database with realistic Tagum City traffic data:

```bash
# Set up a local Python env for scripts
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install sqlalchemy psycopg2-binary python-dotenv

# Create base objects: 1 intersection, 4 streets, 4 CCTVs, 4 regions
python scripts/fake_detections.py --seed

# Fill the last 7 days with realistic detections
python scripts/fake_detections.py --fill
```

`--seed` is idempotent. `--fill` skips hours that already have data.

---

## 7. Set up test RTSP streams (OBS + MediaMTX)

In production the workers connect to real Dahua cameras. For development, simulate streams using OBS.

### Add MediaMTX to Docker Compose (if not already present)

```yaml
  mediamtx:
    image: bluenviron/mediamtx:latest
    container_name: mediamtx
    restart: unless-stopped
    ports:
      - "8554:8554"   # RTSP
      - "1935:1935"   # RTMP (OBS input)
```

### Configure OBS

1. **Settings → Stream → Service: Custom**
2. Server: `rtmp://<host-ip>:1935/live`
3. Stream key: `cam1` (repeat for cam2, cam3, cam4 with separate OBS instances or scenes)
4. Click **Start Streaming**

The worker connects to `rtsp://<host-ip>:8554/cam1`.

If the seed script used `192.168.254.104`, update it to your machine's IP:

```bash
psql -h localhost -p 5433 -U postgres -d traffic \
  -c "UPDATE cctvs SET rtsp_url = replace(rtsp_url, '192.168.254.104', '<your-ip>');"
```

---

## 8. Frontend (development mode)

For local development with hot-reload, run the Vite dev server instead of the Docker frontend container:

```bash
cd eyegila
npm install
npm run dev
```

The dev server starts at **http://localhost:5173** and proxies `/api` to `http://localhost:8000`.

> **Note:** Don't run both the Docker frontend (port 80) and the Vite dev server (port 5173) targeting the same backend at the same time — use one or the other.

---

## 9. Bulk-import intersections and cameras

Instead of adding cameras one by one through the UI, prepare a CSV and import it:

```csv
intersection_name,latitude,longitude,camera_name,rtsp_url
City Hall Intersection,7.4478,125.8057,Cam 1 North,rtsp://192.168.1.100:554/stream1
City Hall Intersection,7.4478,125.8057,Cam 1 South,rtsp://192.168.1.101:554/stream1
Magsaysay Park,7.4466,125.8048,Cam 2 East,rtsp://192.168.1.102:554/stream1
```

Upload via **Cameras → Import CSV** in the UI, or via API:

```bash
curl -X POST http://localhost:8000/intersections/import \
  -H "Authorization: Bearer <token>" \
  -F "file=@cameras.csv"
```

Intersections are matched by name — existing ones are reused, not duplicated.

---

## 10. Run the test suite

The integration tests run against the live stack (requires `docker compose up` and `docker compose --profile frontend up -d frontend`):

```bash
# First time — create a venv and install deps
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements-test.txt

# Run all tests
pytest

# Run a specific file
pytest tests/test_cameras.py

# Stop on first failure
pytest -x
```

To target a remote server:

```bash
API_URL=http://192.168.1.50:8000 \
DATABASE_URL=postgresql://postgres:postgres@192.168.1.50:5433/traffic \
pytest
```

Tests cover: auth + rate limiting, intersection/camera CRUD, CSV import, aggregation history, SSE stream delivery, worker heartbeat claiming, warrant model inference, and health endpoints.

---

## 11. k3s production deployment

### Prerequisites on each node

- k3s installed: `curl -sfL https://get.k3s.io | sh -`
- NVIDIA Container Toolkit installed on GPU nodes
- `kubectl` available (`k3s kubectl` works too)
- Images built and pushed to a registry, or built locally with `docker build`

### Steps

```bash
cd k3s

# 1. Create namespace
kubectl apply -f namespace.yaml

# 2. Fill in your secrets (VAPID keys, DB creds, FERNET_KEY) then apply
kubectl apply -f secret.yaml

# 3. PgBouncer config
kubectl apply -f configmap-pgbouncer.yaml

# 4. Infrastructure
kubectl apply -f timescaledb.yaml
kubectl apply -f pgbouncer.yaml
kubectl apply -f redis.yaml

# 5. NVIDIA device plugin (GPU nodes)
kubectl apply -f nvidia-device-plugin.yaml

# 6. Application services
kubectl apply -f rq-worker.yaml
kubectl apply -f server.yaml
kubectl apply -f worker.yaml
kubectl apply -f frontend.yaml

# 7. Wait for all pods
kubectl get pods -n eyegila -w
```

The frontend NodePort exposes the dashboard at `http://<node-ip>:30080`.

### Smoke test

After deploy, verify the cluster is healthy:

```bash
chmod +x scripts/k3s_smoke_test.sh
./scripts/k3s_smoke_test.sh --server-url http://<node-ip>:30080
```

This checks: namespace exists, all pods Running, `/health` → 200, login works, auth is enforced on protected endpoints, at least one camera is claimed by a worker, and the frontend is serving.

---

## Environment variables reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL DSN pointing at PgBouncer, e.g. `postgresql://postgres:postgres@pgbouncer:5432/traffic` |
| `REDIS_URL` | Yes | — | `redis://redis:6379` |
| `VAPID_PRIVATE_KEY` | Yes | — | PEM-encoded EC private key for Web Push |
| `VAPID_PUBLIC_KEY` | Yes | — | Uncompressed base64url EC public key |
| `UPLOAD_DIR` | Yes | — | Path for uploaded video files, e.g. `/app/uploads` |
| `TZ` | No | `Asia/Manila` | Timezone for day-boundary calculations in aggregation |
| `FERNET_KEY` | No | _(disabled)_ | Base64 Fernet key — encrypts RTSP URLs at rest. Generate: `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `CORS_ORIGINS` | No | `http://localhost:5173` | Comma-separated allowed CORS origins for the API |
| `CAMERAS_PER_WORKER` | No | `1` (mac) / `16` (gpu) | Max cameras each worker process claims |
| `INFERENCE_EVERY_N` | No | `1` | Run inference on every Nth frame (raise to reduce GPU load) |

---

## Development workflow

Source directories are bind-mounted into containers, so most changes take effect without rebuilding:

| Service | After editing code | After changing `requirements.txt` |
|---------|-------------------|----------------------------------|
| `server` | Automatic (uvicorn `--reload` watches the bind mount) | `docker compose build server && docker compose up -d server` |
| `rq-worker` | `docker compose restart rq-worker` | `docker compose build rq-worker && docker compose up -d rq-worker` |
| `worker` | `docker compose --profile worker restart worker` | `docker compose --profile worker build worker && docker compose --profile worker up -d worker` |
| `frontend` | Use `npm run dev` (Vite HMR) or rebuild: `docker compose --profile frontend build frontend && docker compose --profile frontend up -d frontend` | Same as rebuild |

> **Tip:** Run `docker compose logs server -f` to confirm the server reloaded after a file change.

---

## Common issues

### TimescaleDB fails to start

The volume may have stale data from a previous schema. Wipe and restart:

```bash
docker compose down -v
docker compose up --build -d
```

### Workers show "no camera to claim"

No CCTVs are registered, or all cameras already have active worker heartbeats. Run `--seed` to add test cameras, or add cameras via **Cameras → Add Camera** in the UI.

If cameras exist but the worker claims fewer than expected, check `CAMERAS_PER_WORKER`:

```bash
docker exec worker env | grep CAMERAS_PER_WORKER
docker compose logs worker | grep "claiming up to"
```

Set it in `.env`:

```env
CAMERAS_PER_WORKER=4
```

Then `docker compose --profile worker up -d worker` to apply.

### PgBouncer connection refused

PgBouncer requires MD5 auth. The `POSTGRES_PASSWORD` in `docker-compose.yml` and the PgBouncer config must match. Check `pgbouncer.ini` in the repo root.

### Frontend shows a blank page or "network error"

The Docker frontend (Nginx) proxies `/api` to `http://server:8000` inside the Docker network. If you see network errors:

1. Confirm the `server` container is running: `docker compose ps`
2. Check server logs: `docker compose logs server`
3. If running the Vite dev server instead, it proxies to `http://localhost:8000` — ensure the server is also running.

### Login is blocked (HTTP 429)

The login endpoint is rate-limited to **10 attempts per minute per IP**. Wait 60 seconds and try again. In dev, this limit uses in-memory storage; in production it uses Redis.

### Web Push notifications not appearing

1. `VAPID_PUBLIC_KEY` in the server env must match what the frontend was built with.
2. The frontend must be served over HTTPS (or `localhost`) — browsers block `PushManager.subscribe()` on plain HTTP.
3. Check browser console for push subscription errors.

### Dahua RTSP camera format

```
rtsp://<username>:<password>@<camera-ip>:554/cam/realmonitor?channel=1&subtype=0
```

`subtype=0` = main stream; `subtype=1` = sub stream (lower resolution, recommended for inference).

If `FERNET_KEY` is set, RTSP URLs are stored encrypted in the database and decrypted transparently by the worker and server at runtime.

---

## Checking continuous aggregate refresh

If Reports or Heatmap pages show stale data, force an immediate refresh:

```bash
psql -h localhost -p 5433 -U postgres -d traffic \
  -c "CALL refresh_continuous_aggregate('aggregation_summaries', NULL, NULL);"
```

TimescaleDB refreshes this automatically every 30 seconds via a policy — the above is only needed if you need data immediately after a large write.
