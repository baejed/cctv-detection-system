# EyeGila Setup Guide

CCTV traffic detection system. Workers self-assign to cameras automatically — no manual worker management needed.

## Prerequisites

- Docker + Docker Compose v2 (`docker compose version`)
- Git

---

## First-time setup

### 1. Clone and configure

```bash
git clone <repo-url>
cd cctv-detection-system

cp .env.example .env
```

Open `.env` and fill in:

| Variable | Description | Example |
|---|---|---|
| `DB_ROOT_PASSWORD` | MySQL root password | `s3cur3root` |
| `DB_PASSWORD` | App DB password | `s3cur3pass` |
| `SUPER_KEY` | Token for creating users | `openssl rand -hex 32` |
| `WORKER_REPLICAS` | Max cameras you expect | `10` |
| `TZ` | Server timezone | `Asia/Manila` |
| `VAPID_PUBLIC_KEY` | Push notifications (optional) | see below |
| `VAPID_PRIVATE_KEY` | Push notifications (optional) | see below |

To generate VAPID keys (push notifications):
```bash
npx web-push generate-vapid-keys
```

### 2. Start the stack

```bash
make up
# or: docker compose up -d --build --scale worker=10
```

This starts: MySQL, Redis, FastAPI server, N worker pods, React frontend (Nginx).

Wait ~30 seconds for MySQL to initialize on first run.

### 3. Create the first admin user

```bash
curl -s -X POST http://localhost:8000/users/ \
  -H "Authorization: Bearer <your SUPER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "your-password"}' | python3 -m json.tool
```

### 4. Open the UI

Go to **http://localhost** and log in with the admin credentials.

---

## Running and stopping

| Command | What it does |
|---|---|
| `make up` | Build images and start everything |
| `make up WORKERS=10` | Start with 10 worker replicas |
| `make down` | Stop all containers (data is preserved) |
| `make logs` | Tail logs from all services |
| `make worker-logs` | Tail worker logs only |
| `make ps` | Show container status |

---

## Reset (wipe all data)

```bash
make reset
```

This stops all containers, deletes all volumes (database, Redis), removes locally built images, and restarts from scratch. Re-run step 3 to recreate the admin user.

---

## Adding cameras

1. Log in to the UI
2. Create an intersection (Cameras → New Intersection)
3. Add cameras to that intersection (RTSP URL required)
4. A worker pod picks up each camera within **15 seconds** — no restart needed

Each worker pod handles exactly one camera. When all replicas are busy and you add more cameras than `WORKER_REPLICAS`, scale up:

```bash
make up WORKERS=20
# or: docker compose up -d --scale worker=20
```

## Camera status

The API returns `worker_id` and `claimed_at` on each camera record. A camera is being processed if `claimed_at` is within the last 90 seconds.

---

## Bulk import via CSV

Download the template from the Cameras page and fill it in:

| Column | Description |
|---|---|
| `intersection_name` | Created if it doesn't exist |
| `latitude` | Decimal degrees |
| `longitude` | Decimal degrees |
| `camera_name` | Name of the camera |
| `rtsp_url` | RTSP stream URL |

Upload via the **Import CSV** button on the Cameras page, or via API:
```bash
curl -X POST http://localhost:8000/intersections/import \
  -H "Authorization: Bearer <token>" \
  -F "file=@cameras.csv"
```

---

## Services

| Service | Port | Description |
|---|---|---|
| Frontend | 80 | React app (Nginx) |
| API | 8000 | FastAPI server |
| MySQL | (internal) | Database |
| Redis | (internal) | Rate limit / session store |
| Workers | (none) | YOLO detection, one per camera |

---

## Prometheus metrics

```bash
curl http://localhost:8000/metrics
```

Worker heartbeat status:
```bash
TOKEN=$(curl -s -X POST http://localhost:8000/login/ \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/metrics/workers
```

---

## Migrating an existing database

If you already have data and are upgrading to the self-claiming worker system, run this SQL once:

```sql
ALTER TABLE cctvs ADD COLUMN worker_id VARCHAR(255) NULL;
ALTER TABLE cctvs ADD COLUMN claimed_at DATETIME(6) NULL;
```

---

## k3s deployment

Build and push images:
```bash
docker build -f server/Dockerfile -t your-registry/eyegila-server:latest .
docker build -f worker/Dockerfile -t your-registry/eyegila-worker:latest .
docker build -f eyegila/Dockerfile -t your-registry/eyegila-frontend:latest eyegila/
docker push your-registry/eyegila-{server,worker,frontend}:latest
```

Deploy workers (set replicas = max cameras):
```yaml
# k8s/worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: eyegila
spec:
  replicas: 10
  selector:
    matchLabels:
      app: worker
  template:
    metadata:
      labels:
        app: worker
    spec:
      containers:
      - name: worker
        image: your-registry/eyegila-worker:latest
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: eyegila-secrets
              key: database-url
```

Run the smoke test after deployment:
```bash
./scripts/k3s_smoke_test.sh --namespace eyegila
```

---

## Common issues

| Problem | Fix |
|---|---|
| MySQL not ready on first start | Wait 30–60s. `make logs` to watch. |
| Workers show "No cameras available" | Normal — they're waiting for cameras to be added |
| Camera shows `claimed_at = null` | No worker has claimed it yet; check `make worker-logs` |
| Login returns 429 | Rate limit: 10 attempts/minute per IP |
| Push notifications not working | Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in `.env` |
| Regions not updating on live camera | Regions reload every 30s with the heartbeat |
