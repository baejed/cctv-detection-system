# Warrant MLP Integration - Design

**Date:** 2026-05-13
**Branch:** `jed/warrant-model`
**Status:** Approved, ready for implementation plan

## Goal

Replace the rule-based MUTCD warrant analysis in `server/routers/recommendations.py` with the trained PyTorch MLP (`warrant_model.pt` + `warrant_scaler.pkl`). The model predicts per-warrant probabilities (W1, W2, W4, recommended) from 5 hourly traffic features. The existing `recommendations` DB schema and frontend page already match the model's output shape - no DB or UI changes are required.

## Non-goals

- No changes to the `recommendations` DB table (schema already supports W1/W2/W4 + confidences + recommended + notes).
- No changes to the React `Recommendations` page (already renders W1/W2/W4 pills with confidence bars).
- No retraining of the model. We ship the trained `.pt` + `.pkl` as-is.
- No Webster's-formula timing calculation. Out of scope for this change.

## File layout

```
server/
├── ml/
│   ├── __init__.py
│   ├── model.py            # WarrantMLP nn.Module (copied from warrants/model.py)
│   ├── inference.py        # load_warrant_model() + predict_warrants()
│   ├── warrant_model.pt    # trained weights + arch metadata
│   └── warrant_scaler.pkl  # StandardScaler fit on training data
├── routers/
│   └── recommendations.py  # rewritten - model-driven analysis
├── main.py                 # lifespan loads model into app.state
└── requirements.txt        # adds torch (CPU), scikit-learn, numpy
```

The Dockerfile already copies `server/` into the image, so the two model files ship automatically. The server image grows by ~250MB (CPU torch wheel + sklearn). Acceptable.

## Inference module

`server/ml/inference.py` exposes two functions and one NamedTuple:

```python
class WarrantArtifacts(NamedTuple):
    model: WarrantMLP
    scaler: StandardScaler
    input_features: list[str]   # ["major_volume", "minor_volume", "peds", "vpm", "phf"]
    warrants: list[str]         # ["w1", "w2", "w4", "recommended"]

def load_warrant_model(model_path: Path, scaler_path: Path) -> WarrantArtifacts:
    """Called once at app startup. torch.load(weights_only=False) on the .pt,
    pickle.load on the .pkl, rebuild WarrantMLP from the metadata in the
    checkpoint, load_state_dict, model.eval(). Returns frozen artifacts."""

def predict_warrants(
    artifacts: WarrantArtifacts,
    features: dict[str, float],
) -> dict[str, float]:
    """Reorder features dict to artifacts.input_features, scale via
    artifacts.scaler.transform, run model forward, apply sigmoid, return
    a dict like {'w1': 0.99, 'w2': 0.01, 'w4': 0.03, 'recommended': 0.99}."""
```

Decision threshold for the boolean `met` flags is **0.5** (matches the README). The DB stores the float confidence; the bool is derived as `confidence >= 0.5`.

## Lifespan wiring

`server/main.py` `lifespan` loads the model once at startup and stashes it on `app.state`:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    app.state.warrant_artifacts = load_warrant_model(
        Path(__file__).parent / "ml" / "warrant_model.pt",
        Path(__file__).parent / "ml" / "warrant_scaler.pkl",
    )
    task = asyncio.create_task(aggregation_pusher())
    yield
    task.cancel()
```

If `load_warrant_model` raises (missing file, corrupted checkpoint), the server fails to start with a clear traceback. No silent fallback.

Routers read the artifacts via `request.app.state.warrant_artifacts`. No global singleton.

## Feature computation

Given an intersection, compute the 5 features for the **most-recent-complete-hour**:

- `hour_end = floor(now, '1h')` (UTC)
- `hour_start = hour_end - 1h`

Query `aggregation_summaries` for that intersection over `[hour_start, hour_end)`. Each row is `(street_id, direction, object_type, window_start, count)` at 1-minute resolution.

### Major / minor identification

- Group rows by `street_id`, summing `count` for vehicle object types only (everything except `pedestrian` and `person`).
- The street with the highest total = **major**. All other streets summed = **minor**.

### The 5 features

| Feature | Definition |
|---|---|
| `major_volume` | Total vehicle count over the hour on the major street. |
| `minor_volume` | Total vehicle count over the hour on all non-major streets, summed. |
| `peds` | Total count over the hour where `object_type IN ('pedestrian', 'person')`, across all streets. |
| `vpm` | Peak vehicles per minute on the major street: `max(per-minute vehicle count)` across the 60 one-minute buckets. |
| `phf` | Peak Hour Factor on the major street: `major_volume / (4 × peak_15min_volume)`. Re-bucket the 60 minutes into four 15-min sums; take the max. Clamp result to `[0.25, 1.0]`. Default `1.0` if `major_volume == 0`. |

`PEDESTRIAN_TYPES = {"pedestrian", "person"}` - same set the existing router already uses.

### Edge cases

- **No data in the hour** → all features = 0, model predicts not-warranted, notes say `"No data for hour starting <hour_start ISO>"`.
- **Single street** → `minor_volume = 0`. Training distribution includes low-volume cases; model is fine.
- **Pedestrians-only hour** → `vpm = 0`, `phf = 1.0`. Model handles.

### Trade-off note

The previous rule-based code used a 7-day lookback to count "qualifying hours". The model predicts on **one hour** (the most-recent-complete-hour). A recommendation now reflects "is this hour warranting a signal?" instead of "has the past week shown enough qualifying hours?". User has accepted this trade-off.

## Router changes

`server/routers/recommendations.py`:

- **Delete** the constants `WARRANT_1_VEHICLE_THRESHOLD`, `WARRANT_1_HOURS_NEEDED`, `WARRANT_2_*`, `WARRANT_4_*`, `LOOKBACK_DAYS`, and the `_run_warrant_analysis` function.
- **Add** `_compute_features(intersection_id: int, db: Session) -> tuple[dict[str, float], datetime]` - runs the SQL in the section above and returns the features dict plus the `hour_start` timestamp for the notes string.
- **Add** `_analyze(intersection_id, artifacts, db) -> dict` - calls `_compute_features`, calls `predict_warrants`, formats the notes string, returns the dict matching the existing `Recommendation` model fields (`warrant_1_met`, `warrant_1_confidence`, ..., `recommended`, `notes`).
- The 4 endpoints (`GET /`, `POST /generate/{id}`, `POST /generate-all`, `PATCH /{id}/notes`) keep their existing signatures, except `POST /generate/{id}` and `POST /generate-all` now also take `request: Request` so they can pull `request.app.state.warrant_artifacts`. The `PATCH /{id}/notes` endpoint is unchanged.

Notes string format:
> Hour starting 2026-05-13 14:00 UTC. Major: 620 veh/hr, Minor: 180 veh/hr, Peds: 45/hr, VPM: 12, PHF: 0.85. Probabilities - W1: 0.99, W2: 0.01, W4: 0.03.

## Requirements

`server/requirements.txt` gains three lines:
```
torch --index-url https://download.pytorch.org/whl/cpu
scikit-learn
numpy
```

(The torch CPU index keeps the image small. If pinned versions are needed for reproducibility, add them in implementation; for now leave unpinned to track the latest.)

## Testing

### Unit tests - `tests/test_recommendations.py` (new file)

Predict-side (no DB):
- `test_predict_warrants_high_volume` - features `[1200, 200, 10, 25, 0.9]` → assert `recommended` and `w1` both ≥ 0.5.
- `test_predict_warrants_quiet` - features `[100, 20, 5, 2, 0.7]` → assert `recommended` < 0.5.
- `test_predict_warrants_pedestrian` - features `[700, 50, 150, 12, 0.85]` → assert `w4` ≥ 0.5.

Feature-extraction-side (real DB, following existing `conftest.py` pattern):
- `test_feature_extraction_major_minor` - seed three streets with volumes 800, 200, 100. Assert the 800-street is picked as major and `minor_volume == 300`.
- `test_feature_extraction_phf` - uniform 1-minute distribution → PHF near 1.0. Single-minute spike → PHF lower.
- `test_feature_extraction_no_data` - empty window returns all zeros and the "no data" note.

Model-load test:
- `test_load_warrant_model_smoke` - load the real `.pt` + `.pkl`, run one prediction, assert output shape `(4,)` and all values in `[0, 1]`.

### Integration test

In existing `tests/` style - `POST /recommendations/generate/{id}` against the seeded intersection, assert 200 + the response matches `RecommendationResponse`.

### Manual smoke test

1. `docker compose up --build -d`
2. `python scripts/fake_detections.py --seed && python scripts/fake_detections.py --fill`
3. Open `http://localhost/recommendations`, click **Run all**, verify cards render with non-zero probabilities.
4. `docker compose logs server | grep -i warrant` → see exactly one model-load line at startup.

### Verification gate (before claiming done)

- `pytest tests/test_recommendations.py` passes.
- `docker compose up --build` completes without errors.
- `curl -X POST http://localhost:8000/recommendations/generate/1 -H "Authorization: Bearer <token>"` returns the expected schema.
- Model load happens exactly once (single log line on startup).

## Out of scope

- Webster's-formula green-phase timing (model README mentions this as a future step).
- Calibration of probabilities (Platt scaling / isotonic regression).
- Additional warrants (W3, W5-W9) - model is parametric and supports them, but adding requires retraining.
- Adding `road_class` to the `streets` table. We use the volume-based major-pick instead.

## Open questions

None - all design decisions resolved during brainstorming.
