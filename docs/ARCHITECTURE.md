# EyeGila - Architecture & Models Guide

A reading guide for the CCTV-driven traffic signal recommendation system.
Read top-to-bottom for the full picture, or jump to the section you need.

- Related plan: [`docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md`](superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md)
- Related plan (parent): [`docs/superpowers/plans/2026-06-18-tod-clustering-thesis.md`](superpowers/plans/2026-06-18-tod-clustering-thesis.md)

---

## 1. The one-line system summary

EyeGila ingests CCTV streams, runs **YOLOv8** object detection on every Nth
frame in a `worker` service (docker-compose container; a k3d cluster is
available but not the active runtime), aggregates vehicle/pedestrian counts
into a 24-hour flow timeseries per intersection, then feeds that timeseries
plus intersection metadata into a **multi-task 1D-CNN** that jointly predicts
**MUTCD signal warrants** and a **structural intervention class** (signalize /
road_widening / timing_only). A K-means TOD discovery module and Webster's
formula provide supporting signal-timing recommendations.

```
┌──────────┐   RTSP    ┌─────────────┐   detections   ┌──────────────┐
│ CCTV     │ ────────▶ │ Worker      │ ─────────────▶ │ TimescaleDB  │
│ camera   │           │ (YOLOv8)    │                │ (PG16 hyper) │
└──────────┘           └─────────────┘                └──────────────┘
                                                            │
                                          flow_matrix (5×96)│
                                          + IntersectionMeta│
                                                            ▼
                                          ┌────────────────────────────┐
                                          │ TemporalWarrantCNN         │ ←─ thesis centerpiece
                                          │  6 warrant probs           │
                                          │  3-class intervention      │
                                          └────────────────────────────┘
                                                            │
                                          ┌─────────────────┴────────────────┐
                                          ▼                                  ▼
                                  /recommendations API              K-means TOD + Webster's
                                  (FastAPI + React UI)              (signal timing per chunk)
```

---

## 2. Repository layout (only the parts that matter for the model story)

```
server/
  main.py                        FastAPI app + lifespan that loads ML artifacts
  warrant_rules.py               MUTCD W1–W4 pure-function evaluators
  intervention_rules.py          3-class precedence rule (widening > signalize > timing)
  local_warrants.py              Tagum-local W-Local 1/2/3
  webster.py                     Webster's optimal-cycle formula
  tod.py                         Time-of-day chunk utilities
  ml/
    model.py                     WarrantMLP            ← scalar baseline
    inference.py                 predict_warrants      ← baseline inference
    warrant_model.pt             baseline checkpoint
    warrant_scaler.pkl           baseline input scaler
    temporal_warrant.py          TemporalWarrantCNN    ← thesis centerpiece
    temporal_inference.py        predict_recommendations
    multitask_loss.py            UncertaintyWeightedLoss + EqualWeightedLoss
    synthetic_traffic.py         training-data generator
  routers/
    recommendations.py           dispatches scalar vs CNN, returns API payload
worker/
  main.py                        YOLOv8 inference loop on CCTV frames
eyegila_v4.pt                    YOLOv8 weights (vehicle/pedestrian detector)
scripts/
  train_multitask_cnn.py         training CLI (multi-seed)
  tune_multitask_cnn.py          Optuna hyperparameter search
  evaluate_multitask_cnn.py      eval harness (AUC/F1, confusion matrix, saliency)
eyegila/                         React + Vite frontend (TypeScript)
```

---

## 3. The three models in the system

The codebase contains **three distinct ML models**. Don't confuse them.

### 3.1 YOLOv8 - vehicle/pedestrian detector (`eyegila_v4.pt`)

- **Where it lives:** loaded by `worker/main.py:_load_model`.
- **Job:** per-frame bounding-box detection of vehicles, pedestrians, and
  Philippine-specific classes (motorcycle, pedicab, tricycle).
- **Runtime:** GPU TensorRT engine when available, falls back to PyTorch CPU.
  Configurable via `MODEL_VERSION` env var.
- **Output:** detection rows written to Postgres, later rolled up by the
  aggregation pipeline into 1-minute / 15-minute count buckets per
  `(intersection, street, object_type)`.
- **Not part of the thesis contribution** - it's off-the-shelf Ultralytics
  YOLOv8. It feeds the pipeline; it isn't the centerpiece.

### 3.2 WarrantMLP - scalar-feature baseline (`server/ml/model.py`)

The original signal-warrant classifier. **Now retained as the baseline** the
thesis compares against.

| Aspect             | Value                                                                |
|--------------------|----------------------------------------------------------------------|
| File               | `server/ml/model.py`                                                 |
| Checkpoint         | `server/ml/warrant_model.pt` + `warrant_scaler.pkl`                  |
| Inputs             | 5 hand-engineered scalars: `major_volume, minor_volume, peds, vpm, phf` |
| Architecture       | Plain MLP (Linear → ReLU → Dropout) ×N, configurable hidden dims     |
| Output             | 3 sigmoid probabilities - W1, W2, W4 - plus a meta `recommended` flag |
| Loss               | `BCEWithLogitsLoss`                                                  |
| Inference          | `predict_warrants(artifacts, features)` in `server/ml/inference.py`  |
| Role               | Baseline for the thesis comparison; rollback path if CNN fails       |

**Why it's still in the repo:** the PRD locks in rollback safety
(user story #13) - if the recommender artifacts fail to load, the
recommendations router falls back to `predict_warrants`.

### 3.3 TemporalWarrantCNN - multi-task 1D-CNN (`server/ml/temporal_warrant.py`)

The **thesis centerpiece**. A 1D convolutional network with late-fused
intersection metadata and two task heads.

| Aspect             | Value                                                                                       |
|--------------------|---------------------------------------------------------------------------------------------|
| File               | `server/ml/temporal_warrant.py`                                                             |
| Checkpoint env var | `TEMPORAL_CNN_MODEL_PATH` (default `server/ml/temporal_cnn_model.pt`)                       |
| Inputs (flow)      | `(5, 96)` channels-first - 4 vehicle approaches + 1 pedestrian channel, 15-min slot rates   |
| Inputs (metadata)  | 5-element vector: `major_lanes, minor_lanes, posted_speed_kph, is_signalized, n_approaches` |
| Warrant head       | 6 logits - `w1, w2, w3, w4, w_local_2, w_local_3` (multi-label sigmoid at inference time)   |
| Intervention head  | 3 logits - `signalize, road_widening, timing_only` (softmax at inference time)              |
| Parameters         | ~62.6K (see breakdown in the file's module docstring)                                       |
| Inference          | `predict_recommendations(artifacts, flow_matrix, metadata)` in `temporal_inference.py`      |

> **API-surface caveat.** The CNN emits all 6 warrant probabilities, but
> `recommendations.py:_analyze` currently persists only `w1 / w2 / w4` to the
> response payload. `w3`, `w_local_2`, `w_local_3` from the CNN are computed
> and logged but dropped. The `w_local_1/2/3_met` fields you see on the
> `/recommendations` response come from the rule modules
> (`server/local_warrants.py`), not the CNN. Either wire the dropped heads
> through or trim the warrant head to 3 outputs.

#### Layer-by-layer view

```
flow (B, 5, 96)
  │
  ├─ Conv1d(5→32, k=5) ─ BN ─ ReLU ─ MaxPool(2)        # (B, 32, 48)
  ├─ Conv1d(32→64, k=5) ─ BN ─ ReLU ─ MaxPool(2)       # (B, 64, 24)
  ├─ Conv1d(64→128, k=5) ─ BN ─ ReLU ─ AdaptiveAvgPool # (B, 128, 1) → (B, 128)
  └─ Dropout(0.3)                                      # "temporal flatten"
                                                                │
metadata (B, 5) ─ Linear(5→16) ─ ReLU ─────────────┐            │
                                                   ▼            ▼
                                          concat → (B, 144)
                                                   │
                                          Linear(144→64) ─ ReLU ─ Dropout(0.3)
                                                   │
                                  ┌────────────────┴────────────────┐
                                  ▼                                 ▼
                          Linear(64→6) warrant_logits   Linear(64→3) intervention_logits
```

Sigmoid and softmax happen at **inference time** in `temporal_inference.py`,
not inside the model - so training feeds raw logits straight into
`BCEWithLogitsLoss` / `CrossEntropyLoss`.

#### Multi-task loss (`server/ml/multitask_loss.py`)

The training loss combines the two task losses via Kendall et al. 2018's
homoscedastic uncertainty weighting:

```
L = BCE_warrant / (2·σ_w²) + CE_intervention / (2·σ_i²) + log(σ_w · σ_i)
```

`log_sigma_w` and `log_sigma_i` are learnable `nn.Parameter` scalars
(log-space keeps σ strictly positive without clamping). An equal-weight
ablation (`EqualWeightedLoss`) ships alongside for the results-chapter
comparison.

---

## 4. The supporting (non-thesis) algorithms

These exist in the system but are framed as **supporting infrastructure**, not
the algorithmic contribution.

### 4.1 K-means TOD discovery

Unsupervised clustering of 15-min flow slots into time-of-day "chunks"
(Overnight / AM Rush / Midday / PM Rush / Evening). Defaults are seeded by
`server/tod.py:TOD_DEFAULTS`; K-means later refines them per intersection.

**Output:** `TodChunk` rows in Postgres with `start_minutes`, `end_minutes`.
**Consumers:** Webster's (per-chunk timing) and the synthetic data generator
(critical v/c for intervention labels).

### 4.2 Webster's optimal-cycle formula (`server/webster.py`)

Closed-form signal-timing optimizer. Not learned, not replaced.

```
L      = n_phases · (lost_time + all_red_clearance)
y_i    = max-flow_i / saturation_flow
Y      = Σ y_i
C_opt  = (1.5L + 5) / (1 - Y)
```

**In production:** picks the cycle length and green splits per `TodChunk`.
**At training time:** the critical v/c it computes is what drives the
`road_widening` intervention label (>0.90 → widen).

### 4.3 MUTCD warrant rules (`server/warrant_rules.py`, `server/local_warrants.py`)

Pure-function evaluators for:

- **W1** Eight-Hour Vehicular Volume - MUTCD §4C.02, Table 4C-1
- **W2** Four-Hour Vehicular Volume - MUTCD §4C.03, Figure 4C-1
- **W3** Peak Hour - MUTCD §4C.04, Figure 4C-3
- **W4** Pedestrian Volume - MUTCD §4C.05
- **W-Local 1** High motorcycle/pedicab ratio (Tagum-specific)
- **W-Local 2** Peak concentration (≥70% in top 1–2 chunks)
- **W-Local 3** Lights-off (very low volume periods)

Low-speed multiplier of 0.70 applies when `posted_speed_kph ≤ 40`.

**Two purposes:** generate ground-truth labels for the synthetic training set,
and serve as the rule-based fallback for warrants the CNN doesn't predict
(W-Local 1 remains a runtime rule).

### 4.4 Intervention precedence (`server/intervention_rules.py`)

Deterministic label-assignment rule for the synthetic dataset:

```
1. road_widening  if critical_vc > 0.90
2. signalize      if (not is_signalized) and any warrant met
3. timing_only    otherwise
```

The CNN's intervention head **learns** this mapping from the flow
timeseries - it doesn't call this function at inference time.

---

## 5. Data flow end-to-end

```
[1] CCTV RTSP stream
        │
        ▼
[2] worker/main.py
      • YOLOv8 detection on every Nth frame
      • Track IDs (DeepSORT-style)
      • Writes Detection rows to TimescaleDB
        (PostgreSQL 16 + Timescale; `detections` is a hypertable
         partitioned on the `time` column - not `timestamp`)
        │
        ▼
[3] Aggregation pipeline (server/routers/aggregation.py)
      • Roll up detections into 1-min / 15-min buckets
      • Per (intersection, street, object_type)
        │
        ▼
[4] /recommendations request (or scheduled analysis_loop)
      • _compute_features → 5 hand-engineered scalars (for logging / display)
      • _build_flow_matrix → (5, 96) channels-first array
      • _intersection_to_meta → IntersectionMeta dataclass
        │
        ▼
[5] Dispatch (server/routers/recommendations.py:_analyze)
      • If app.state.recommender_artifacts loaded → TemporalWarrantCNN path
            predict_recommendations(artifacts, flow_matrix, meta)
              → warrant_probs (dict of 6) + intervention + confidence
              (only w1/w2/w4 are persisted to the API payload today;
               w3, w_local_2, w_local_3 are computed and logged but dropped)
      • Else → WarrantMLP baseline path
            predict_warrants(artifacts, features)
              → warrant_probs (dict of 3)
        │
        ▼
[6] Recommendation row persisted; response includes:
      • W1/W2/W4 met flags + confidence
      • W-Local 1/2/3 met flags + confidence (from rule modules)
      • intervention: {class, confidence}  ← new T16 field
      • timing_cycle, timing_chunk (from Webster's)
        │
        ▼
[7] React frontend (eyegila/src) renders recommendation cards
```

---

## 6. Production wiring (lifespan + dispatch)

Both models are loaded once at FastAPI startup in `server/main.py`'s
lifespan and cached on `app.state`:

```python
app.state.warrant_artifacts     = load_warrant_model(...)   # MLP baseline
app.state.recommender_artifacts = load_recommender(...)     # multi-task CNN
```

Either may be `None` if its checkpoint is missing - both failure paths log a
warning rather than crashing the server.

`server/routers/recommendations.py:_analyze` is the **single dispatch point**:

- Recommender loaded → CNN path.
- Recommender missing **or CNN raises** → automatic fallthrough to the scalar
  baseline. This is the user-story #13 rollback contract.

### Deployment mode

The active runtime is **docker-compose** (`server`, `worker`, `rq-worker`,
`pgbouncer`, `timescaledb`, `redis`, `frontend`). A k3d cluster
(`k3d-eyegila-*`) is provisioned for k8s smoke-tests (see
`scripts/k3s_smoke_test.sh`) but does not host the application pods in
day-to-day use. Treat references to "worker pods" as a future-k8s framing,
not the current topology.

---

## 7. Training (offline, CLI-driven)

Training is **not** bundled into the FastAPI app - it's invoked from CLI
scripts under `scripts/`.

| Script                          | Purpose                                                              |
|---------------------------------|----------------------------------------------------------------------|
| `train_multitask_cnn.py`        | Multi-seed training (`{0,1,2,3,4}`), early stopping, checkpoint emit |
| `tune_multitask_cnn.py`         | Optuna search over lr, dropout, loss-weight init                     |
| `evaluate_multitask_cnn.py`     | Per-warrant AUC/F1 table, intervention confusion matrix, saliency    |

**Synthetic dataset:** ~5,400 samples (30 synthetic intersections × 90 days
× 2 day-types) generated by `server/ml/synthetic_traffic.py`. Splits are
**intersection-stratified** (21 train / 4 val / 5 test) so no test
intersection appears in any training-related data.

**Optimizer:** Adam, lr 1e-3, weight decay 1e-5. Up to 100 epochs, batch 64,
early stopping patience 10. Intervention head uses class-weighted CE because
`timing_only` dominates (~50–65% of samples).

---

## 8. API contract

`/recommendations` returns the existing recommendation bundle plus one
additive field:

```jsonc
{
  // ...existing fields...
  "warrant_1_met": true,                // ← from CNN (head: w1)
  "warrant_1_confidence": 0.82,
  // warrant_2_*, warrant_4_* likewise come from CNN heads w2, w4.
  // warrant_3_* is NOT in the payload today (CNN head w3 is dropped).
  "w_local_1_met": false,               // ← from rules (server/local_warrants.py)
  "w_local_1_confidence": 0.00,
  "w_local_2_met": false,               // ← from rules, NOT from CNN head w_local_2
  "w_local_2_confidence": 0.11,
  "w_local_3_met": false,               // ← from rules, NOT from CNN head w_local_3
  "w_local_3_confidence": 0.00,
  "recommended": true,
  "recommended_confidence": 0.91,
  // ─── New T16 field ────────────────────────────────────
  "intervention": {
    "class": "signalize",          // | "road_widening" | "timing_only"
    "confidence": 0.91
  },
  // ─────────────────────────────────────────────────────
  "timing_cycle": 95,
  "timing_chunk": "AM Rush"
}
```

The CNN warrant head has 6 outputs, but the payload today only carries
W1/W2/W4 from the CNN. W-Local 1/2/3 are always rule-sourced. Frontend
consumers wanting CNN-derived W3 or W-Local 2/3 will need the dispatch in
`recommendations.py:_analyze` to be extended first.

---

## 9. Testing strategy

| Test file                             | What it covers                                                       |
|---------------------------------------|----------------------------------------------------------------------|
| `tests/test_warrant_rules.py`         | Each MUTCD evaluator vs. hand-crafted `(flow, meta)` fixtures        |
| `tests/test_intervention_rules.py`    | All 3 precedence outcomes + tie cases                                |
| `tests/test_local_warrants.py`        | W-Local 1/2/3 pure-function tests                                    |
| `tests/test_synthetic_traffic.py`     | Determinism, schema completeness, class-balance sanity               |
| `tests/test_temporal_warrant.py`      | Inference contract: `RecommendationResult` shape, value ranges       |
| `tests/test_recommendations.py`       | Integration tests against the recommendations router                 |
| `evaluate_multitask_cnn.py` (script)  | Acts as the model-quality gate - multi-seed mean±std, ablation, etc. |

Principle: **test external behavior, not internal layer activations.** Tests
should survive a layer-width change.

---

## 10. Glossary

| Term                     | Meaning                                                                    |
|--------------------------|----------------------------------------------------------------------------|
| PCU                      | Passenger Car Unit - vehicle-type-weighted volume unit                     |
| MUTCD                    | US FHWA Manual on Uniform Traffic Control Devices (warrant authority)      |
| W1–W4                    | MUTCD signal warrants (vehicular volume, pedestrian, etc.)                 |
| W-Local 1/2/3            | Tagum-specific warrants (motorcycle ratio, peak concentration, lights-off) |
| TOD chunk                | Time-of-day partition of the 24-hour day (e.g. "AM Rush" 06:00–09:00)      |
| v/c (critical)           | Critical volume-to-capacity ratio output by Webster's                      |
| flow_matrix              | `(5, 96)` channels-first array - 4 approaches + peds × 96 15-min slots     |
| IntersectionMeta         | dataclass - `major_lanes, minor_lanes, posted_speed_kph, is_signalized, n_approaches` |
| Recommender artifacts    | The loaded CNN + label metadata, cached on `app.state.recommender_artifacts` |
| Warrant artifacts        | The loaded MLP + scaler, cached on `app.state.warrant_artifacts`           |

---

## 11. Where to look next

- **Want to understand the centerpiece in depth?** Start at
  `server/ml/temporal_warrant.py` (module docstring is the spec) and read the
  PRD §Implementation Decisions.
- **Want to see how a request flows?** Read `server/routers/recommendations.py:_analyze`.
- **Want to understand the training data?** Read `server/ml/synthetic_traffic.py`
  alongside `server/warrant_rules.py` and `server/intervention_rules.py`.
- **Want to know what the baseline is doing?** `server/ml/model.py` +
  `server/ml/inference.py`.
- **Want to see the YOLO loop?** `worker/main.py` (look for `_load_model`,
  `INFERENCE_EVERY_N`).
