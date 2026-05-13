# Warrant MLP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rule-based MUTCD warrant analysis in `server/routers/recommendations.py` with the trained PyTorch MLP (`warrant_model.pt` + `warrant_scaler.pkl`), so recommendations come from the model's per-warrant probabilities computed on the most-recent-complete-hour of traffic data.

**Architecture:** Model + scaler ship inside the server Docker image at `server/ml/`. FastAPI lifespan loads them once into `app.state.warrant_artifacts`. The recommendations router queries `aggregation_summaries` for the last completed hour, derives 5 features (`major_volume`, `minor_volume`, `peds`, `vpm`, `phf`) where the busiest street is treated as the major road, runs the model, and writes the result to the unchanged `recommendations` table.

**Tech Stack:** Python 3.11, PyTorch (CPU), scikit-learn, FastAPI, SQLAlchemy, PostgreSQL/TimescaleDB.

**Spec:** `docs/superpowers/specs/2026-05-13-warrant-model-integration-design.md`

---

## File Map

**Create:**
- `server/ml/__init__.py` — package marker, re-exports
- `server/ml/model.py` — `WarrantMLP` nn.Module
- `server/ml/inference.py` — `load_warrant_model()`, `predict_warrants()`, `WarrantArtifacts` NamedTuple
- `server/ml/warrant_model.pt` — copied artifact (binary)
- `server/ml/warrant_scaler.pkl` — copied artifact (binary)
- `tests/test_recommendations.py` — unit + integration tests

**Modify:**
- `server/requirements.txt` — add torch, scikit-learn, numpy
- `requirements-test.txt` — add torch, scikit-learn, numpy
- `server/main.py` — load artifacts in lifespan, stash on `app.state`
- `server/routers/recommendations.py` — replace rule-based analysis with model-driven

---

### Task 1: Add ML dependencies to requirements

**Files:**
- Modify: `server/requirements.txt`
- Modify: `requirements-test.txt`

- [ ] **Step 1: Add torch / sklearn / numpy to server requirements**

Edit `server/requirements.txt`. The current content is:
```
bcrypt
fastapi[standard]
python-dotenv
sqlalchemy
psycopg2-binary
rq
redis
opencv-python-headless
prometheus-fastapi-instrumentator
cryptography
slowapi
```

Add three lines at the end:
```
numpy
scikit-learn
--extra-index-url https://download.pytorch.org/whl/cpu
torch
```

Final file:
```
bcrypt
fastapi[standard]
python-dotenv
sqlalchemy
psycopg2-binary
rq
redis
opencv-python-headless
prometheus-fastapi-instrumentator
cryptography
slowapi
numpy
scikit-learn
--extra-index-url https://download.pytorch.org/whl/cpu
torch
```

- [ ] **Step 2: Mirror the additions in requirements-test.txt**

Edit `requirements-test.txt` from:
```
pytest
requests
sqlalchemy
psycopg2-binary
```

To:
```
pytest
requests
sqlalchemy
psycopg2-binary
numpy
scikit-learn
--extra-index-url https://download.pytorch.org/whl/cpu
torch
```

- [ ] **Step 3: Commit**

```bash
git add server/requirements.txt requirements-test.txt
git commit -m "build: add torch, scikit-learn, numpy for warrant model inference"
```

---

### Task 2: Add the `server/ml` package and copy artifacts

**Files:**
- Create: `server/ml/__init__.py`
- Create: `server/ml/model.py`
- Create: `server/ml/warrant_model.pt` (copied)
- Create: `server/ml/warrant_scaler.pkl` (copied)

- [ ] **Step 1: Create `server/ml/__init__.py`**

Empty file:
```python
```

- [ ] **Step 2: Create `server/ml/model.py` with the WarrantMLP class**

```python
"""WarrantMLP — the architecture for the saved warrant_model.pt checkpoint.

Mirrors the architecture from the warrants/ training repo. The .pt checkpoint
stores `input_features`, `warrants`, `hidden_dims`, and `dropout` alongside
the state_dict so we can reconstruct the exact architecture at load time.
"""
from __future__ import annotations

import torch
from torch import nn


class WarrantMLP(nn.Module):
    def __init__(
        self,
        input_features: list[str],
        warrants: list[str],
        hidden_dims: tuple[int, ...],
        dropout: float,
    ) -> None:
        super().__init__()
        self.input_features = list(input_features)
        self.warrants = list(warrants)

        layers: list[nn.Module] = []
        in_dim = len(input_features)
        for h in hidden_dims:
            layers.append(nn.Linear(in_dim, h))
            layers.append(nn.ReLU())
            layers.append(nn.Dropout(dropout))
            in_dim = h
        layers.append(nn.Linear(in_dim, len(warrants)))

        self.net = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)
```

- [ ] **Step 3: Copy the artifact files**

Run these from the repo root:
```bash
cp /Users/josephtristansubong/Downloads/warrant_model.pt server/ml/warrant_model.pt
cp /Users/josephtristansubong/Downloads/warrant_scaler.pkl server/ml/warrant_scaler.pkl
ls -la server/ml/
```

Expected: both files present, `warrant_model.pt` ~13KB, `warrant_scaler.pkl` ~570 bytes.

- [ ] **Step 4: Smoke-load the model to verify the architecture matches**

Run this one-liner from the repo root:
```bash
python3 -c "
import pickle, torch, sys
sys.path.insert(0, '.')
from server.ml.model import WarrantMLP

ckpt = torch.load('server/ml/warrant_model.pt', map_location='cpu', weights_only=False)
m = WarrantMLP(
    input_features=ckpt['input_features'],
    warrants=ckpt['warrants'],
    hidden_dims=ckpt['hidden_dims'],
    dropout=ckpt['dropout'],
)
m.load_state_dict(ckpt['state_dict'])
m.eval()

with open('server/ml/warrant_scaler.pkl', 'rb') as f:
    scaler = pickle.load(f)

import numpy as np
X = scaler.transform(np.array([[620, 180, 45, 12, 0.85]], dtype=np.float32)).astype(np.float32)
with torch.no_grad():
    probs = torch.sigmoid(m(torch.from_numpy(X))).squeeze(0).tolist()
print(dict(zip(ckpt['warrants'], probs)))
"
```

Expected: prints something like `{'w1': 0.99..., 'w2': 0.0..., 'w4': 0.0..., 'recommended': 0.99...}`. No errors.

If `load_state_dict` complains about missing/unexpected keys, the architecture in `model.py` doesn't match the checkpoint — stop and reconcile before proceeding.

- [ ] **Step 5: Commit**

```bash
git add server/ml/__init__.py server/ml/model.py server/ml/warrant_model.pt server/ml/warrant_scaler.pkl
git commit -m "feat: add warrant MLP model class and trained artifacts"
```

---

### Task 3: Build the inference module

**Files:**
- Create: `server/ml/inference.py`

- [ ] **Step 1: Write `server/ml/inference.py`**

```python
"""Inference helpers for the warrant MLP.

Two public functions:
    load_warrant_model(model_path, scaler_path) -> WarrantArtifacts
    predict_warrants(artifacts, features) -> dict[str, float]

Both are pure functions. Call load_warrant_model once at app startup and cache
the result on app.state.
"""
from __future__ import annotations

import pickle
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch
from sklearn.preprocessing import StandardScaler

from server.ml.model import WarrantMLP


class WarrantArtifacts(NamedTuple):
    model: WarrantMLP
    scaler: StandardScaler
    input_features: list[str]
    warrants: list[str]


def load_warrant_model(model_path: Path, scaler_path: Path) -> WarrantArtifacts:
    """Load the warrant model and scaler from disk. Call once at app startup."""
    ckpt = torch.load(model_path, map_location="cpu", weights_only=False)
    model = WarrantMLP(
        input_features=ckpt["input_features"],
        warrants=ckpt["warrants"],
        hidden_dims=ckpt["hidden_dims"],
        dropout=ckpt["dropout"],
    )
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    with open(scaler_path, "rb") as f:
        scaler = pickle.load(f)

    return WarrantArtifacts(
        model=model,
        scaler=scaler,
        input_features=ckpt["input_features"],
        warrants=ckpt["warrants"],
    )


def predict_warrants(
    artifacts: WarrantArtifacts,
    features: dict[str, float],
) -> dict[str, float]:
    """Run inference on one feature dict, return {warrant_name: probability}."""
    ordered = np.array(
        [[features[name] for name in artifacts.input_features]],
        dtype=np.float32,
    )
    scaled = artifacts.scaler.transform(ordered).astype(np.float32)
    with torch.no_grad():
        logits = artifacts.model(torch.from_numpy(scaled))
        probs = torch.sigmoid(logits).squeeze(0).tolist()
    return dict(zip(artifacts.warrants, probs))
```

- [ ] **Step 2: Write the failing test in `tests/test_recommendations.py` for predict_warrants**

Create `tests/test_recommendations.py`:
```python
"""Tests for the warrant model inference + the /recommendations endpoints."""
from __future__ import annotations

from pathlib import Path

import pytest

from server.ml.inference import load_warrant_model, predict_warrants


@pytest.fixture(scope="module")
def artifacts():
    repo_root = Path(__file__).resolve().parent.parent
    return load_warrant_model(
        repo_root / "server" / "ml" / "warrant_model.pt",
        repo_root / "server" / "ml" / "warrant_scaler.pkl",
    )


def test_predict_warrants_high_volume(artifacts):
    """High major + minor volume should trigger W1 and recommended."""
    probs = predict_warrants(artifacts, {
        "major_volume": 1200,
        "minor_volume": 200,
        "peds": 10,
        "vpm": 25,
        "phf": 0.9,
    })
    assert set(probs.keys()) == {"w1", "w2", "w4", "recommended"}
    assert probs["w1"] >= 0.5, f"w1 was {probs['w1']}"
    assert probs["recommended"] >= 0.5, f"recommended was {probs['recommended']}"


def test_predict_warrants_quiet(artifacts):
    """Low traffic should not trigger any warrant."""
    probs = predict_warrants(artifacts, {
        "major_volume": 100,
        "minor_volume": 20,
        "peds": 5,
        "vpm": 2,
        "phf": 0.7,
    })
    assert probs["recommended"] < 0.5, f"recommended was {probs['recommended']}"


def test_predict_warrants_pedestrian(artifacts):
    """High pedestrian volume with moderate major volume should trigger W4."""
    probs = predict_warrants(artifacts, {
        "major_volume": 700,
        "minor_volume": 50,
        "peds": 150,
        "vpm": 12,
        "phf": 0.85,
    })
    assert probs["w4"] >= 0.5, f"w4 was {probs['w4']}"


def test_predict_warrants_output_shape(artifacts):
    """All probabilities must be in [0, 1] and match the artifact warrants list."""
    probs = predict_warrants(artifacts, {
        "major_volume": 500,
        "minor_volume": 100,
        "peds": 30,
        "vpm": 10,
        "phf": 0.8,
    })
    assert list(probs.keys()) == artifacts.warrants
    for name, p in probs.items():
        assert 0.0 <= p <= 1.0, f"{name} probability out of [0,1]: {p}"
```

- [ ] **Step 3: Run the inference tests**

```bash
pytest tests/test_recommendations.py -v -k predict_warrants
```

Expected: all 4 tests pass. If torch/numpy/sklearn aren't installed, install them per Task 1's `requirements-test.txt` first: `pip install -r requirements-test.txt`.

- [ ] **Step 4: Commit**

```bash
git add server/ml/inference.py tests/test_recommendations.py
git commit -m "feat: add warrant model inference module with unit tests"
```

---

### Task 4: Load model in FastAPI lifespan

**Files:**
- Modify: `server/main.py`

- [ ] **Step 1: Edit the lifespan in `server/main.py`**

Replace lines 31-36:
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    task = asyncio.create_task(aggregation_pusher())
    yield
    task.cancel()
```

With:
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
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
```

The imports are inside the function so the cost is only paid at startup (not at module import) and so unit tests of other routers don't drag torch in.

- [ ] **Step 2: Verify the server starts cleanly**

If Docker Compose is running:
```bash
docker compose up --build -d server
docker compose logs --tail=50 server
```

Expected: no exception in startup logs; the server is `running` in `docker compose ps`. The model file path is `/app/server/ml/warrant_model.pt` inside the container — Path resolution works because `__file__` is the in-container path.

If running outside Docker:
```bash
uvicorn server.main:app --port 8000 &
sleep 3
curl -s http://localhost:8000/health
kill %1
```

Expected: `{"status":"ok"}`.

- [ ] **Step 3: Commit**

```bash
git add server/main.py
git commit -m "feat: load warrant model into app.state at startup"
```

---

### Task 5: Add feature computation helpers to recommendations router

**Files:**
- Modify: `server/routers/recommendations.py`

- [ ] **Step 1: Write the failing tests for feature extraction**

Append to `tests/test_recommendations.py`:
```python
from datetime import datetime, timezone

from server.routers.recommendations import _compute_features_from_rows


# Simple row objects (mimics SQLAlchemy Row) — name, value pairs the function reads.
class _Row:
    def __init__(self, street_id, object_type, window_start, count):
        self.street_id = street_id
        self.object_type = object_type
        self.window_start = window_start
        self.count = count


def _ts(minute: int) -> datetime:
    return datetime(2026, 5, 13, 14, minute, tzinfo=timezone.utc)


def test_feature_extraction_major_minor():
    """Busiest street is major; the rest summed is minor."""
    rows = []
    # Major street (id=1): 800 vehicles spread evenly
    for m in range(60):
        rows.append(_Row(1, "car", _ts(m), 800 // 60 + (1 if m < 800 % 60 else 0)))
    # Minor street A (id=2): 200 vehicles
    for m in range(60):
        rows.append(_Row(2, "car", _ts(m), 200 // 60 + (1 if m < 200 % 60 else 0)))
    # Minor street B (id=3): 100 vehicles
    for m in range(60):
        rows.append(_Row(3, "car", _ts(m), 100 // 60 + (1 if m < 100 % 60 else 0)))

    feats = _compute_features_from_rows(rows)

    assert feats["major_volume"] == 800
    assert feats["minor_volume"] == 300  # 200 + 100


def test_feature_extraction_peds_separated_from_vehicles():
    """Pedestrian object types must not count toward major/minor volumes."""
    rows = [
        _Row(1, "car", _ts(0), 500),
        _Row(1, "pedestrian", _ts(0), 40),
        _Row(2, "person", _ts(0), 60),  # different street, still pedestrian
    ]
    feats = _compute_features_from_rows(rows)
    assert feats["major_volume"] == 500
    assert feats["minor_volume"] == 0
    assert feats["peds"] == 100  # 40 + 60


def test_feature_extraction_vpm_peak_per_minute():
    """vpm is the highest per-minute vehicle count on the major street."""
    rows = [
        # Major street (id=1): 70 total, peak minute is 12
        _Row(1, "car", _ts(0), 5),
        _Row(1, "motorcycle", _ts(0), 3),  # same minute, same street → sum to 8
        _Row(1, "car", _ts(1), 12),
        _Row(1, "car", _ts(2), 7),
        _Row(1, "car", _ts(3), 43),  # extra to keep street 1 as major (70 total)
        # Minor street (id=2): 30 total in one minute; not major, so its 30 doesn't drive vpm
        _Row(2, "car", _ts(0), 30),
    ]
    feats = _compute_features_from_rows(rows)
    assert feats["major_volume"] == 70  # 8 + 12 + 7 + 43
    assert feats["minor_volume"] == 30
    assert feats["vpm"] == 43  # peak per-minute on major street (minute 3)


def test_feature_extraction_phf_uniform_is_one():
    """A perfectly uniform hour has PHF = 1.0."""
    rows = [_Row(1, "car", _ts(m), 10) for m in range(60)]
    feats = _compute_features_from_rows(rows)
    assert feats["major_volume"] == 600
    # 15-min buckets each = 150; peak15 = 150; phf = 600 / (4*150) = 1.0
    assert feats["phf"] == pytest.approx(1.0)


def test_feature_extraction_phf_spike_lower():
    """A spike in one 15-min bucket lowers PHF."""
    rows = []
    # Minutes 0-14: 40/min = 600 in first quarter
    for m in range(15):
        rows.append(_Row(1, "car", _ts(m), 40))
    # Minutes 15-59: 0
    feats = _compute_features_from_rows(rows)
    # major_volume = 600; peak15 = 600; phf = 600 / (4*600) = 0.25
    assert feats["phf"] == pytest.approx(0.25)


def test_feature_extraction_no_data_returns_zeros():
    """Empty rows yields a zero-feature dict and phf defaults to 1.0."""
    feats = _compute_features_from_rows([])
    assert feats == {
        "major_volume": 0,
        "minor_volume": 0,
        "peds": 0,
        "vpm": 0,
        "phf": 1.0,
    }


def test_feature_extraction_phf_clamp_min():
    """PHF is clamped to a minimum of 0.25 (the theoretical floor)."""
    # Construct an extreme spike — impossible normally but tests the clamp.
    # 100 vehicles all in minute 0 → 15-min bucket 0 = 100; total = 100; phf = 100/(4*100)=0.25
    rows = [_Row(1, "car", _ts(0), 100)]
    feats = _compute_features_from_rows(rows)
    assert feats["phf"] == pytest.approx(0.25)
```

- [ ] **Step 2: Run the failing tests**

```bash
pytest tests/test_recommendations.py -v -k feature_extraction
```

Expected: all tests fail with `ImportError: cannot import name '_compute_features_from_rows'`.

- [ ] **Step 3: Implement `_compute_features_from_rows` and `_compute_features` in `server/routers/recommendations.py`**

Add `from collections import defaultdict` to the top of the file if it's not already imported. The existing module already defines `PEDESTRIAN_TYPES = {"pedestrian", "person"}` — reuse it; do not redefine it.

Add these functions to `server/routers/recommendations.py` (place them above `_run_warrant_analysis` for now; we'll delete `_run_warrant_analysis` in Task 6):

```python
def _compute_features_from_rows(rows) -> dict[str, float]:
    """Pure function: from one hour of aggregation rows, compute the 5 features.

    Each row must have attributes: street_id, object_type, window_start, count.

    Returns a dict with major_volume, minor_volume, peds, vpm, phf.
    """
    # Per-street vehicle totals (excludes pedestrians) — used to pick major street
    street_veh: dict[int, int] = defaultdict(int)
    # Pedestrian total across all streets / directions
    peds_total = 0
    # Per-(street, minute) vehicle counts — for vpm and phf on the major street
    per_minute: dict[tuple[int, int], int] = defaultdict(int)

    for r in rows:
        if r.object_type in PEDESTRIAN_TYPES:
            peds_total += r.count
            continue
        street_veh[r.street_id] += r.count
        per_minute[(r.street_id, r.window_start.minute)] += r.count

    if not street_veh:
        return {
            "major_volume": 0,
            "minor_volume": 0,
            "peds": peds_total,
            "vpm": 0,
            "phf": 1.0,
        }

    major_id = max(street_veh, key=street_veh.get)
    major_volume = street_veh[major_id]
    minor_volume = sum(v for sid, v in street_veh.items() if sid != major_id)

    # vpm = max per-minute total for the major street
    major_minute_counts = [c for (sid, _m), c in per_minute.items() if sid == major_id]
    vpm = max(major_minute_counts) if major_minute_counts else 0

    # phf = hour_volume / (4 * peak_15min_volume) on the major street, clamped to [0.25, 1.0]
    if major_volume == 0:
        phf = 1.0
    else:
        bucket_15: dict[int, int] = defaultdict(int)
        for (sid, minute), c in per_minute.items():
            if sid != major_id:
                continue
            bucket_15[minute // 15] += c
        peak_15 = max(bucket_15.values()) if bucket_15 else 0
        if peak_15 == 0:
            phf = 1.0
        else:
            phf = major_volume / (4 * peak_15)
            phf = max(0.25, min(1.0, phf))

    return {
        "major_volume": int(major_volume),
        "minor_volume": int(minor_volume),
        "peds": int(peds_total),
        "vpm": int(vpm),
        "phf": float(phf),
    }


def _compute_features(intersection_id: int, db: Session) -> tuple[dict[str, float], datetime]:
    """Query aggregation_summaries for the most-recent-complete-hour and compute features.

    Returns (features_dict, hour_start_utc).
    """
    now = datetime.now(timezone.utc)
    hour_end = now.replace(minute=0, second=0, microsecond=0)
    hour_start = hour_end - timedelta(hours=1)

    rows = db.execute(text("""
        SELECT street_id, object_type, window_start, SUM(count)::int AS count
        FROM aggregation_summaries
        WHERE intersection_id = :iid
          AND window_start >= :start
          AND window_start <  :end
        GROUP BY street_id, object_type, window_start
    """), {"iid": intersection_id, "start": hour_start, "end": hour_end}).fetchall()

    return _compute_features_from_rows(rows), hour_start
```

Note: `datetime` and `timedelta` are already imported at the top of the file; `text` is already imported; `Session` is already imported. If any are missing, add them.

- [ ] **Step 4: Run the feature extraction tests**

```bash
pytest tests/test_recommendations.py -v -k feature_extraction
```

Expected: all 7 feature extraction tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routers/recommendations.py tests/test_recommendations.py
git commit -m "feat: add feature extraction helpers for warrant model"
```

---

### Task 6: Replace `_run_warrant_analysis` with model-driven `_analyze`

**Files:**
- Modify: `server/routers/recommendations.py`

- [ ] **Step 1: Add an `_analyze` function and delete the rule-based code**

In `server/routers/recommendations.py`, delete the following old constants and the entire `_run_warrant_analysis()` function. Keep `PEDESTRIAN_TYPES` (it's still used by `_compute_features_from_rows` from Task 5). Keep `RecommendationResponse`, `NotesUpdate`, and all four endpoints.

Delete:
- `WARRANT_1_VEHICLE_THRESHOLD`, `WARRANT_1_HOURS_NEEDED`
- `WARRANT_2_VEHICLE_THRESHOLD`, `WARRANT_2_HOURS_NEEDED`
- `WARRANT_4_PED_THRESHOLD`, `WARRANT_4_HOURS_NEEDED`
- `LOOKBACK_DAYS`
- The full `_run_warrant_analysis()` function and the multi-line comments above it about MUTCD thresholds

Add (after `_compute_features`):

```python
def _analyze(
    intersection_id: int,
    artifacts,
    db: Session,
) -> dict:
    """Compute features for the most recent hour, run the model, format result.

    Returns a dict with all the columns of the Recommendation model.
    """
    from server.ml.inference import predict_warrants  # local import keeps top of file clean

    features, hour_start = _compute_features(intersection_id, db)

    if features["major_volume"] == 0 and features["minor_volume"] == 0 and features["peds"] == 0:
        return {
            "warrant_1_met": False, "warrant_1_confidence": 0.0,
            "warrant_2_met": False, "warrant_2_confidence": 0.0,
            "warrant_4_met": False, "warrant_4_confidence": 0.0,
            "recommended":   False,
            "notes": f"No data for hour starting {hour_start.isoformat()}.",
        }

    probs = predict_warrants(artifacts, features)
    w1, w2, w4, rec = probs["w1"], probs["w2"], probs["w4"], probs["recommended"]

    notes = (
        f"Hour starting {hour_start.isoformat()}. "
        f"Major: {features['major_volume']} veh/hr, "
        f"Minor: {features['minor_volume']} veh/hr, "
        f"Peds: {features['peds']}/hr, "
        f"VPM: {features['vpm']}, "
        f"PHF: {features['phf']:.2f}. "
        f"Probabilities — W1: {w1:.2f}, W2: {w2:.2f}, W4: {w4:.2f}."
    )

    return {
        "warrant_1_met":        w1 >= 0.5,
        "warrant_1_confidence": round(float(w1), 4),
        "warrant_2_met":        w2 >= 0.5,
        "warrant_2_confidence": round(float(w2), 4),
        "warrant_4_met":        w4 >= 0.5,
        "warrant_4_confidence": round(float(w4), 4),
        "recommended":          rec >= 0.5,
        "notes":                notes,
    }
```

- [ ] **Step 2: Update `generate_recommendation` to use `_analyze` and the request state**

Replace the existing `generate_recommendation` function:

```python
@router.post("/generate/{intersection_id}", response_model=RecommendationResponse)
def generate_recommendation(
    intersection_id: int,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis for one intersection and upsert the result."""
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    analysis = _analyze(intersection_id, request.app.state.warrant_artifacts, db)

    existing = (
        db.query(models.Recommendation)
        .filter(models.Recommendation.intersection_id == intersection_id)
        .first()
    )
    if existing:
        db.delete(existing)
        db.flush()

    rec = models.Recommendation(intersection_id=intersection_id, **analysis)
    db.add(rec)
    db.commit()
    db.refresh(rec)

    return {
        "id": rec.id,
        "intersection_id": rec.intersection_id,
        "intersection_name": intersection.name,
        "warrant_1_met": rec.warrant_1_met,
        "warrant_1_confidence": rec.warrant_1_confidence,
        "warrant_2_met": rec.warrant_2_met,
        "warrant_2_confidence": rec.warrant_2_confidence,
        "warrant_4_met": rec.warrant_4_met,
        "warrant_4_confidence": rec.warrant_4_confidence,
        "recommended": rec.recommended,
        "notes": rec.notes,
        "generated_at": rec.generated_at.isoformat(),
    }
```

Add `Request` to the FastAPI imports at the top of the file:
```python
from fastapi import APIRouter, Depends, HTTPException, Request
```

- [ ] **Step 3: Update `generate_all_recommendations` the same way**

Replace the existing `generate_all_recommendations` function:

```python
@router.post("/generate-all", response_model=list[RecommendationResponse])
def generate_all_recommendations(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis for every intersection."""
    intersections = db.query(models.Intersection).all()
    results = []

    artifacts = request.app.state.warrant_artifacts

    for intersection in intersections:
        analysis = _analyze(intersection.id, artifacts, db)

        existing = (
            db.query(models.Recommendation)
            .filter(models.Recommendation.intersection_id == intersection.id)
            .first()
        )
        if existing:
            db.delete(existing)
            db.flush()

        rec = models.Recommendation(intersection_id=intersection.id, **analysis)
        db.add(rec)
        db.flush()
        db.refresh(rec)

        results.append({
            "id": rec.id,
            "intersection_id": rec.intersection_id,
            "intersection_name": intersection.name,
            "warrant_1_met": rec.warrant_1_met,
            "warrant_1_confidence": rec.warrant_1_confidence,
            "warrant_2_met": rec.warrant_2_met,
            "warrant_2_confidence": rec.warrant_2_confidence,
            "warrant_4_met": rec.warrant_4_met,
            "warrant_4_confidence": rec.warrant_4_confidence,
            "recommended": rec.recommended,
            "notes": rec.notes,
            "generated_at": rec.generated_at.isoformat(),
        })

    db.commit()
    return results
```

- [ ] **Step 4: Re-run the unit + feature extraction tests**

```bash
pytest tests/test_recommendations.py -v
```

Expected: all tests still pass (the changes don't affect predict_warrants or _compute_features_from_rows).

- [ ] **Step 5: Commit**

```bash
git add server/routers/recommendations.py
git commit -m "feat: replace rule-based warrant analysis with model-driven inference"
```

---

### Task 7: Integration test against the running stack

**Files:**
- Modify: `tests/test_recommendations.py`

- [ ] **Step 1: Add an integration test that exercises the full endpoint**

Append to `tests/test_recommendations.py`. Also add `import os` and `API_URL = os.getenv("API_URL", "http://localhost:8000")` near the top of the file if not already present.

```python
# ─── Integration tests (require docker compose stack + seed data) ────────────


def _first_intersection_id(auth) -> int:
    """Helper — fetch the first intersection from the live API."""
    r = auth.get(f"{API_URL}/intersections/")
    assert r.status_code == 200, r.text
    items = r.json()
    assert items, "No intersections seeded — run scripts/fake_detections.py --seed first"
    return items[0]["id"]


def test_generate_recommendation_endpoint(auth):
    """POST /recommendations/generate/{id} returns the expected schema."""
    iid = _first_intersection_id(auth)
    r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    assert r.status_code == 200, r.text
    body = r.json()

    # Schema check
    expected_keys = {
        "id", "intersection_id", "intersection_name",
        "warrant_1_met", "warrant_1_confidence",
        "warrant_2_met", "warrant_2_confidence",
        "warrant_4_met", "warrant_4_confidence",
        "recommended", "notes", "generated_at",
    }
    assert set(body.keys()) == expected_keys

    # Bool/float types
    for k in ("warrant_1_met", "warrant_2_met", "warrant_4_met", "recommended"):
        assert isinstance(body[k], bool)
    for k in ("warrant_1_confidence", "warrant_2_confidence", "warrant_4_confidence"):
        assert isinstance(body[k], (int, float))
        assert 0.0 <= body[k] <= 1.0

    # Notes is present and references the hour
    assert body["notes"]


def test_generate_all_endpoint(auth):
    """POST /recommendations/generate-all returns one entry per intersection."""
    r = auth.post(f"{API_URL}/recommendations/generate-all")
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body, list)
    assert len(body) >= 1
```

- [ ] **Step 2: Run the integration tests against the live stack**

Make sure the stack is running and seeded:
```bash
docker compose up --build -d
sleep 10  # wait for server to load model + DB to be ready
# If you haven't seeded before:
python scripts/fake_detections.py --seed
python scripts/fake_detections.py --fill
```

Run:
```bash
pytest tests/test_recommendations.py -v -k "generate"
```

Expected: both endpoint tests pass. `generate_recommendation_endpoint` returns 200 and the response schema matches. The notes field should mention "Hour starting" or "No data for hour starting".

If `test_generate_recommendation_endpoint` returns a not-warranted result with "No data" — that's fine (recent-hour may be empty in test data). What matters is the schema.

- [ ] **Step 3: Commit**

```bash
git add tests/test_recommendations.py
git commit -m "test: add integration tests for warrant model recommendations endpoint"
```

---

### Task 8: Manual smoke test + final verification

**Files:** None — verification only.

- [ ] **Step 1: Rebuild and run the full stack**

```bash
docker compose down
docker compose up --build -d
```

Expected: `docker compose ps` shows all containers `healthy` or `running`. No exception in `docker compose logs server`.

- [ ] **Step 2: Verify model loaded exactly once**

```bash
docker compose logs server 2>&1 | grep -ci 'error\|exception\|traceback'
```

Expected: 0 (no errors). The model load is implicit (no explicit log line), so if startup completed without exception, the model loaded.

Verify the server can answer:
```bash
curl -s http://localhost:8000/health
```

Expected: `{"status":"ok"}`.

- [ ] **Step 3: Seed data and exercise the endpoint via curl**

```bash
# Seed if not done
python scripts/fake_detections.py --seed
python scripts/fake_detections.py --fill

# Get a token
TOKEN=$(curl -s -X POST http://localhost:8000/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

# Find an intersection
IID=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8000/intersections/ \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')

# Generate
curl -s -X POST "http://localhost:8000/recommendations/generate/$IID" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected: a JSON response with all 12 keys (`id`, `intersection_id`, `intersection_name`, three pairs of warrant fields, `recommended`, `notes`, `generated_at`). The `notes` field starts with "Hour starting" or "No data for hour starting".

- [ ] **Step 4: Verify in the frontend**

Open `http://localhost/recommendations` in a browser, log in as `admin/admin`, click **Run all**. Each intersection card should render with three warrant pills (W1/W2/W4) showing percentages, and the bottom note should be the model-formatted string.

- [ ] **Step 5: Run the full test suite one more time**

```bash
pytest tests/test_recommendations.py -v
```

Expected: all tests pass.

- [ ] **Step 6: Final commit (only if there are stragglers)**

```bash
git status
# If clean, nothing to commit. Otherwise:
# git add <files> && git commit -m "..."
```

---

## Summary of all commits

After full execution, the branch should have these new commits on top of the spec commit:
1. `build: add torch, scikit-learn, numpy for warrant model inference`
2. `feat: add warrant MLP model class and trained artifacts`
3. `feat: add warrant model inference module with unit tests`
4. `feat: load warrant model into app.state at startup`
5. `feat: add feature extraction helpers for warrant model`
6. `feat: replace rule-based warrant analysis with model-driven inference`
7. `test: add integration tests for warrant model recommendations endpoint`
