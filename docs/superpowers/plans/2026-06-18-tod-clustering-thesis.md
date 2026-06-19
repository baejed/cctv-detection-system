# TOD Clustering + WarrantMLP Thesis Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an unsupervised K-means time-of-day (TOD) regime-discovery algorithm to the signal-timing recommendation pipeline, then position it alongside the existing supervised WarrantMLP as the two-paradigm algorithmic core of the CS thesis. Evaluated on synthetic parameter-realistic flow data with known ground-truth regimes.

**Thesis-level claim:**
> The proposed system provides automated decision support for traffic signal timing in Tagum City. CCTV-derived per-approach flow timeseries feed two algorithmic components: (i) **K-means clustering** that discovers per-intersection time-of-day regimes (unsupervised), and (ii) a supervised multi-label **MLP** that classifies MUTCD signal warrants. Discovered regimes drive a Webster's-based timing engine; warrant classifications identify unsignalized intersections that meet signalization criteria. The system is evaluated on a parameter-realistic synthetic dataset against hand-configured and naive baselines using cluster-recovery metrics and an HCM-based delay simulator.

**Architecture:**
- *Data layer (existing):* CCTV → YOLOv8 → counts → PCE → flow timeseries. For the thesis, replaced by a synthetic-data generator with controllable ground-truth regimes.
- *Algorithm layer (this plan):* K-means TOD discovery + WarrantMLP (already trained).
- *Engine layer (existing):* Webster's per-chunk + HCM simulator + improvement evaluator.
- *Output:* Per-intersection timing recommendation bundle (TodChunks → cycle + splits per chunk → before/after delay).

**Tech Stack:** Python 3.11, scikit-learn (`KMeans`, `StandardScaler`, clustering metrics), NumPy, PyTorch (existing, for MLP), FastAPI, SQLAlchemy, PostgreSQL/TimescaleDB.

**Two ML paradigms, two decisions:**

| Algorithm | Decision | Paradigm | Output |
|---|---|---|---|
| K-means | *When does this intersection's regime change?* | Unsupervised | Named TOD chunks |
| WarrantMLP | *Does this intersection meet criteria for signalization?* | Supervised, multi-label | Warrant probabilities |

---

## File Map

**Create:**
- `server/ml/tod_features.py` — build `(96, 4)` flow matrix per intersection per day-type
- `server/ml/tod_clustering.py` — K-means clustering, semantic naming, contiguous-chunk collapse, top-level pipeline
- `server/ml/synthetic_traffic.py` — synthetic data generator with ground-truth regimes
- `server/routers/tod_discovery.py` — `POST /intersections/{id}/discover-tod-chunks` route
- `scripts/generate_synthetic_dataset.py` — one-shot CLI to materialize the thesis dataset
- `scripts/evaluate_tod_clustering.py` — thesis evaluation harness (intrinsic + downstream metrics)
- `tests/test_tod_clustering.py` — unit tests
- `tests/test_synthetic_traffic.py` — unit tests
- `docs/superpowers/specs/2026-06-18-tod-clustering-design.md` — companion spec (architecture/decisions)

**Modify:**
- `server/requirements.txt` — add `scikit-learn` (if not already pulled in by torch)
- `server/scheduler.py` — register weekly TOD-discovery job per intersection
- `server/main.py` — register the new router
- `common/models.py` — only if a `tod_discovery_mode` column is added (deferred — synthetic thesis doesn't need it)

---

## Phase 1 — Synthetic data generator

### Task 1: Define the synthetic data model

**Files:** Create `server/ml/synthetic_traffic.py`.

- [ ] **Step 1: Define ground-truth regimes**

Four named regimes, each with a flow profile vector `(NB, SB, EB, WB)` in PCU/hr:

```python
GROUND_TRUTH_REGIMES = {
    "AM_RUSH":  (850, 250, 700, 300),   # inbound dominant
    "MIDDAY":   (420, 380, 410, 390),   # balanced
    "PM_RUSH":  (250, 850, 300, 700),   # outbound dominant
    "OFF_PEAK": (90,  80,  85,  75),    # low all directions
}
```

Parameter justification (cite in methods chapter): peak/off-peak ratio ≈ 9–10× matches published Philippine urban AADT distributions; AM/PM directional asymmetry reflects typical commute patterns.

- [ ] **Step 2: Define the regime schedule for an "average weekday"**

Map each of the 96 15-min slots to its ground-truth regime:

```python
def regime_for_slot(slot_index: int) -> str:
    minutes = slot_index * 15
    if 360 <= minutes < 600:    return "AM_RUSH"    # 06:00–10:00
    if 600 <= minutes < 900:    return "MIDDAY"     # 10:00–15:00
    if 900 <= minutes < 1140:   return "PM_RUSH"    # 15:00–19:00
    return "OFF_PEAK"
```

- [ ] **Step 3: Implement the noise/variation model**

```python
def sample_flow_for_slot(regime: str, day_of_week: int, rng) -> tuple[float, ...]:
    base = GROUND_TRUTH_REGIMES[regime]
    dow_modifier = 1.0 + rng.normal(0, 0.05)         # ±5% day-to-day
    noise = rng.normal(0, 0.10, size=4)              # ±10% Gaussian per approach
    return tuple(max(0, b * dow_modifier * (1 + n)) for b, n in zip(base, noise))
```

### Task 2: Multi-week dataset generator

- [ ] **Step 1: Generate N weeks × M intersections × 96 slots/day**

```python
def generate_dataset(n_weeks: int, intersection_ids: list[int], seed: int = 42) -> pd.DataFrame:
    """Return rows: (intersection_id, datetime, slot_index, regime, flow_NB, flow_SB, flow_EB, flow_WB)."""
```

- [ ] **Step 2: Per-intersection variation**

Each intersection gets a small random perturbation of the base regime profiles (scale 0.8–1.2 per approach) so the K-means runs aren't identical.

- [ ] **Step 3: Weekend variant**

Weekends use a flatter schedule: `OFF_PEAK` overnight + `MIDDAY` for most of the day + a small `PM_RUSH` window. Document in methods chapter.

### Task 3: CLI to materialize the dataset

- [ ] **Step 1: Create `scripts/generate_synthetic_dataset.py`**

Writes the generated rows into a Parquet file at `data/synthetic_traffic.parquet` AND optionally into `aggregation_summaries` table so the existing Webster's/simulator code can consume it unchanged.

### Task 4: Tests for the generator

- [ ] **Step 1: Determinism test** — same seed produces same data
- [ ] **Step 2: Schedule integrity** — every slot has exactly one regime label
- [ ] **Step 3: Statistical sanity** — across weeks, the empirical means per slot are within 15% of the ground-truth regime profile

---

## Phase 2 — K-means clustering module

### Task 5: Flow matrix builder

**Files:** Create `server/ml/tod_features.py`.

- [ ] **Step 1: `build_flow_matrix(db, intersection_id, day_type) → np.ndarray`**

Returns shape `(96, 4)`. Reads from `aggregation_summaries` (populated either by real CCTV or the synthetic generator). Uses existing `server/pce.py:resolve_pce`. Filters by `day_type ∈ {'weekday', 'weekend'}` via `EXTRACT(DOW)`.

- [ ] **Step 2: Edge cases** — missing slots filled with intersection's per-approach mean; raise if >50% of slots are missing.

### Task 6: K-means + semantic naming

**Files:** Create `server/ml/tod_clustering.py`.

- [ ] **Step 1: `cluster_intersection(matrix) → (KMeans, labels)`**

```python
scaler = StandardScaler()
X = scaler.fit_transform(matrix)
km = KMeans(n_clusters=4, random_state=42, n_init=10).fit(X)
return km, km.labels_
```

- [ ] **Step 2: `assign_semantic_names(labels, matrix) → dict[int, str]`**

Deterministic rule:
1. Compute per-cluster mean flow (sum across approaches) and per-cluster mean slot-index.
2. Cluster with lowest mean flow → `OFF_PEAK`.
3. Of remaining three: lowest mean slot-index (earliest in day) → `AM_RUSH`; highest mean slot-index → `PM_RUSH`; middle → `MIDDAY`.

- [ ] **Step 3: `collapse_to_chunks(labels, names) → list[dict]`**

Majority vote in a 4-slot (1-hour) sliding window, then collapse consecutive same-labeled slots into `(start_minutes, end_minutes, name)` ranges. Same name can appear multiple times (e.g., OFF_PEAK before AM and after PM).

### Task 7: Top-level pipeline

- [ ] **Step 1: `discover_tod_chunks(db, intersection_id) → None`**

Pipeline: for each `day_type ∈ {weekday, weekend}` → build matrix → cluster → name → collapse → upsert `TodChunk` rows (delete existing, insert new). Wrap in a transaction.

### Task 8: Tests

- [ ] **Step 1:** `assign_semantic_names` returns the 4 expected labels given known centroids
- [ ] **Step 2:** `collapse_to_chunks` produces contiguous ranges covering `[0, 1440)` minutes
- [ ] **Step 3:** End-to-end test on synthetic data — discovered chunk boundaries within ±30 min of injected ground-truth boundaries

---

## Phase 3 — Pipeline integration

### Task 9: API route

**Files:** Create `server/routers/tod_discovery.py`. Modify `server/main.py`.

- [ ] **Step 1:** `POST /intersections/{id}/discover-tod-chunks` — runs `discover_tod_chunks` and returns the discovered `TodChunk` rows + cluster metadata (silhouette score, K-means inertia).
- [ ] **Step 2:** Register the router in `server/main.py`.

### Task 10: Scheduler hook

**Files:** Modify `server/scheduler.py`.

- [ ] **Step 1:** Add weekly job: for every intersection, call `discover_tod_chunks`. Skip if `<4 weeks` of data available.
- [ ] **Step 2:** After clustering, trigger the existing recommendation-regeneration flow so `TimingRecommendation` and `SimulationResult` rows refresh.

---

## Phase 4 — Evaluation harness

### Task 11: Evaluation script

**Files:** Create `scripts/evaluate_tod_clustering.py`.

- [ ] **Step 1: Cluster-recovery metrics** (intrinsic, exploits synthetic ground truth)
  - Adjusted Rand Index between predicted labels and ground-truth labels per intersection
  - Cluster purity
  - Silhouette score (sanity check on K=4 choice; also run K ∈ {2,3,4,5})
- [ ] **Step 2: Boundary-recovery metric**
  - For each ground-truth boundary, compute distance (minutes) to nearest predicted boundary
  - Report mean / median / max
- [ ] **Step 3: Downstream simulator comparison**
  - Run Webster's + simulator using **(a)** ground-truth chunks, **(b)** K-means-discovered chunks, **(c)** naive baseline (one chunk for the whole day) and **(d)** fixed time-of-day baseline (clock-based, ignoring data)
  - For each, record per-chunk and total `delay`, `vc_ratio`, `vehicle_hours_saved`
- [ ] **Step 4: Stability test**
  - Run K-means on weeks 1–3 vs weeks 2–4
  - Report % of slots whose labels change between the two runs
- [ ] **Step 5: Output a CSV results table** ready for inclusion in the thesis results chapter

### Task 12: Thesis figures

- [ ] **Step 1:** Per-intersection heatmap: 24h × 7d with regime color coding (discovered vs ground truth)
- [ ] **Step 2:** Bar chart of Δdelay by baseline (one bar per (a)(b)(c)(d) per intersection)
- [ ] **Step 3:** Confusion matrix of discovered vs ground-truth regimes

---

## Phase 5 — WarrantMLP framing (mostly writing)

### Task 13: Verify wiring

- [ ] **Step 1:** Confirm `WarrantMLP` is loaded in `server/main.py` lifespan (from `2026-05-13-warrant-model-integration.md`)
- [ ] **Step 2:** Confirm `server/routers/recommendations.py` surfaces warrant probabilities in the recommendation bundle
- [ ] **Step 3:** End-to-end smoke test on synthetic data

### Task 14: Methods-chapter description

- [ ] **Step 1:** Architecture diagram (input features → hidden layers → multi-label sigmoid)
- [ ] **Step 2:** Training data summary (from the warrants training repo)
- [ ] **Step 3:** Inference flow diagram + integration with recommendation engine

---

## Phase 6 — Thesis writing

### Task 15: Methods chapter

- [ ] **Section 1: Data acquisition** — CCTV pipeline as the input layer; note the use of synthetic data for evaluation
- [ ] **Section 2: Synthetic data generator** — ground-truth regimes, parameter sourcing, noise model
- [ ] **Section 3: K-means TOD discovery** — feature matrix, scaling, clustering, semantic naming, chunk collapse
- [ ] **Section 4: WarrantMLP classification** — architecture, features, training procedure
- [ ] **Section 5: Webster's engine + HCM simulator** — closed-form baselines used downstream

### Task 16: Results chapter

- [ ] **Section 1:** Cluster-recovery metrics table (ARI, purity, silhouette per intersection)
- [ ] **Section 2:** Boundary-recovery distribution
- [ ] **Section 3:** Downstream simulator comparison table (Δdelay vs baselines)
- [ ] **Section 4:** Stability metrics
- [ ] **Section 5:** WarrantMLP retrospective (confusion matrix, AUC per warrant)
- [ ] **Section 6:** Worked example: one intersection end-to-end (heatmap → discovered chunks → timing plan → before/after delays → warrant verdict)

### Task 17: Discussion

- [ ] **Limitations:** standalone intersections only; fixed-time controllers; synthetic-data evaluation deferred to real-CCTV deployment
- [ ] **Future work:** online forecasting (LSTM), corridor coordination, adaptive control

---

## Total scope estimate

| Phase | Effort |
|---|---|
| 1. Synthetic data | 3–4 days |
| 2. K-means module | 4–5 days |
| 3. Pipeline integration | 2 days |
| 4. Evaluation harness | 3–4 days |
| 5. WarrantMLP wrap-up | 1 day |
| 6. Writing | Ongoing |

**Implementation total: ~2.5 weeks.** Writing concurrent.

---

## Open decisions deferred

- `tod_discovery_mode` column for operator approval workflow — **deferred**, not needed for synthetic thesis.
- LSTM forecasting module — **deferred to future work**, scope-creep risk.
- Corridor coordination — **explicitly out of scope** per scope decision.
