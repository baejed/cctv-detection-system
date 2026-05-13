# Recommendations Page Revamp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retrofit the React `/recommendations` page around the warrant model — a sortable, filterable table of every intersection plus a click-to-open side drawer with the model's feature inputs, probability bars, and run history — and extend the backend to expose structured metric fields and per-intersection history.

**Architecture:**
- Backend: alembic migration adds seven nullable columns to `recommendations`, drops the delete-on-regen behavior, returns structured fields, exposes a new `GET /recommendations/history/{intersection_id}` endpoint, and switches list to `DISTINCT ON (intersection_id)`.
- Frontend: replace the card grid in `Recommendations.tsx` with a shadcn `Table` driven by client-side sort/filter state; row click opens a shadcn `Sheet` with tabs (Latest features + notes editor / History trend chart + list).

**Tech Stack:**
- Backend: FastAPI, SQLAlchemy, Alembic, PostgreSQL/TimescaleDB, PyTorch (already wired).
- Frontend: React + Vite, TypeScript, shadcn/ui (`table`, `sheet`, `tabs`, `badge`, `progress`, `textarea`, `input`, `separator`, `button`), recharts, sonner.
- Tests: `pytest` against a live stack (`docker compose up`, DB on `:5433`, API on `:8000`). Frontend has no test framework; verification is manual via `npm run dev`.

**Spec reference:** [`docs/superpowers/specs/2026-05-14-recommendations-page-revamp-design.md`](../specs/2026-05-14-recommendations-page-revamp-design.md)

---

## Pre-flight

Before starting tasks:

- Verify `docker compose -f docker-compose.mac.yml up -d` (or the standard `docker-compose.yml`) brings the stack up: Postgres on `localhost:5433`, API on `localhost:8000`.
- Seed data: `python scripts/fake_detections.py --seed` to ensure at least one intersection + recent detection data exists.
- Ensure `pytest` runs cleanly against the existing tests:
  ```bash
  pytest tests/test_recommendations.py -v
  ```
  Expected: existing tests pass.
- Frontend dev server: `cd eyegila && npm install && npm run dev` (Vite proxies `/api` to the FastAPI server).

---

## Task 1: Alembic migration — extend `recommendations` table

**Files:**
- Create: `alembic/versions/0004_recommendations_metrics_and_history.py`

- [ ] **Step 1: Create the migration file**

```python
"""recommendations metrics + history support

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-14
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("recommendations", sa.Column("major_volume", sa.Integer(), nullable=True))
    op.add_column("recommendations", sa.Column("minor_volume", sa.Integer(), nullable=True))
    op.add_column("recommendations", sa.Column("peds", sa.Integer(), nullable=True))
    op.add_column("recommendations", sa.Column("vpm", sa.Integer(), nullable=True))
    op.add_column("recommendations", sa.Column("phf", sa.Float(), nullable=True))
    op.add_column("recommendations", sa.Column("recommended_confidence", sa.Float(), nullable=True))
    op.add_column("recommendations", sa.Column("hour_start", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        "ix_recommendations_intersection_generated",
        "recommendations",
        ["intersection_id", sa.text("generated_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_recommendations_intersection_generated", table_name="recommendations")
    op.drop_column("recommendations", "hour_start")
    op.drop_column("recommendations", "recommended_confidence")
    op.drop_column("recommendations", "phf")
    op.drop_column("recommendations", "vpm")
    op.drop_column("recommendations", "peds")
    op.drop_column("recommendations", "minor_volume")
    op.drop_column("recommendations", "major_volume")
```

- [ ] **Step 2: Apply the migration**

Run: `alembic upgrade head`
Expected: `INFO  [alembic.runtime.migration] Running upgrade 0003 -> 0004, recommendations metrics + history support`

- [ ] **Step 3: Verify the columns + index exist**

Run:
```bash
psql postgresql://postgres:postgres@localhost:5433/traffic -c "\d recommendations"
```
Expected: columns `major_volume, minor_volume, peds, vpm, phf, recommended_confidence, hour_start` present; index `ix_recommendations_intersection_generated` listed.

- [ ] **Step 4: Commit**

```bash
git add alembic/versions/0004_recommendations_metrics_and_history.py
git commit -m "feat: alembic 0004 — recommendations metrics + history index"
```

---

## Task 2: Extend `Recommendation` SQLAlchemy model

**Files:**
- Modify: `common/models.py` (the `Recommendation` class)

- [ ] **Step 1: Add the new columns to the model**

Edit `common/models.py`, replace the `Recommendation` class with:

```python
class Recommendation(Base):
    __tablename__ = "recommendations"

    id                     = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id        = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    warrant_1_met          = Column(Boolean, nullable=False, default=False)
    warrant_1_confidence   = Column(Float,   nullable=False, default=0.0)
    warrant_2_met          = Column(Boolean, nullable=False, default=False)
    warrant_2_confidence   = Column(Float,   nullable=False, default=0.0)
    warrant_4_met          = Column(Boolean, nullable=False, default=False)
    warrant_4_confidence   = Column(Float,   nullable=False, default=0.0)
    recommended            = Column(Boolean, nullable=False, default=False)
    recommended_confidence = Column(Float,   nullable=True)
    major_volume           = Column(Integer, nullable=True)
    minor_volume           = Column(Integer, nullable=True)
    peds                   = Column(Integer, nullable=True)
    vpm                    = Column(Integer, nullable=True)
    phf                    = Column(Float,   nullable=True)
    hour_start             = Column(DateTime(timezone=True), nullable=True)
    notes                  = Column(Text,    nullable=True)
    generated_at           = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    intersection = relationship("Intersection", back_populates="recommendations")
```

- [ ] **Step 2: Restart the API so the model picks up new columns**

Run: `docker compose restart server`
Expected: server comes up clean (check `docker compose logs server | tail -30`).

- [ ] **Step 3: Commit**

```bash
git add common/models.py
git commit -m "feat: extend Recommendation model with metric + hour_start columns"
```

---

## Task 3: Refactor `_analyze` to return structured fields; update `RecommendationResponse`

**Files:**
- Modify: `server/routers/recommendations.py`
- Test reference: `tests/test_recommendations.py`

- [ ] **Step 1: Write failing integration test**

Append to `tests/test_recommendations.py`:

```python
def test_generate_returns_structured_fields(auth):
    """POST /recommendations/generate/{id} returns the new metric fields."""
    iid = _first_intersection_id(auth)
    r = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    assert r.status_code == 200, r.text
    body = r.json()

    new_keys = {
        "major_volume", "minor_volume", "peds", "vpm", "phf",
        "recommended_confidence", "hour_start",
    }
    assert new_keys.issubset(body.keys())

    # hour_start is ISO 8601 or null; if data exists, it must be present.
    if body["major_volume"] is not None and body["major_volume"] > 0:
        assert body["hour_start"] is not None
        # roughly parseable
        from datetime import datetime
        datetime.fromisoformat(body["hour_start"].replace("Z", "+00:00"))

    # notes is no longer auto-populated by the analysis itself
    # (engineer-only after this change — may be null on a fresh row)
    assert "notes" in body
```

- [ ] **Step 2: Run and verify it fails**

Run: `pytest tests/test_recommendations.py::test_generate_returns_structured_fields -v`
Expected: FAIL — assertion on `new_keys.issubset(body.keys())` (KeyError or AssertionError).

- [ ] **Step 3: Update `RecommendationResponse` pydantic schema**

In `server/routers/recommendations.py`, replace the `RecommendationResponse` class:

```python
class RecommendationResponse(BaseModel):
    id: int
    intersection_id: int
    intersection_name: str
    warrant_1_met: bool
    warrant_1_confidence: float
    warrant_2_met: bool
    warrant_2_confidence: float
    warrant_4_met: bool
    warrant_4_confidence: float
    recommended: bool
    recommended_confidence: Optional[float] = None
    major_volume: Optional[int] = None
    minor_volume: Optional[int] = None
    peds: Optional[int] = None
    vpm: Optional[int] = None
    phf: Optional[float] = None
    hour_start: Optional[str] = None
    notes: Optional[str]
    generated_at: str

    class Config:
        from_attributes = True
```

- [ ] **Step 4: Refactor `_analyze` to return structured fields and no auto-notes**

Replace the `_analyze` function in `server/routers/recommendations.py`:

```python
def _analyze(
    intersection_id: int,
    artifacts,
    db: Session,
) -> dict:
    """Compute features for the most recent hour, run the model, return a flat dict
    suitable for kwargs into `models.Recommendation(...)`.
    """
    from server.ml.inference import predict_warrants  # local import keeps top of file clean

    features, hour_start = _compute_features(intersection_id, db)

    if features["major_volume"] == 0 and features["minor_volume"] == 0 and features["peds"] == 0:
        return {
            "warrant_1_met": False, "warrant_1_confidence": 0.0,
            "warrant_2_met": False, "warrant_2_confidence": 0.0,
            "warrant_4_met": False, "warrant_4_confidence": 0.0,
            "recommended":            False,
            "recommended_confidence": 0.0,
            "major_volume": 0, "minor_volume": 0, "peds": 0, "vpm": 0, "phf": 1.0,
            "hour_start": hour_start,
            "notes": None,
        }

    probs = predict_warrants(artifacts, features)
    w1, w2, w4, rec = probs["w1"], probs["w2"], probs["w4"], probs["recommended"]

    return {
        "warrant_1_met":          w1 >= 0.5,
        "warrant_1_confidence":   round(float(w1), 4),
        "warrant_2_met":          w2 >= 0.5,
        "warrant_2_confidence":   round(float(w2), 4),
        "warrant_4_met":          w4 >= 0.5,
        "warrant_4_confidence":   round(float(w4), 4),
        "recommended":            rec >= 0.5,
        "recommended_confidence": round(float(rec), 4),
        "major_volume":           int(features["major_volume"]),
        "minor_volume":           int(features["minor_volume"]),
        "peds":                   int(features["peds"]),
        "vpm":                    int(features["vpm"]),
        "phf":                    float(features["phf"]),
        "hour_start":             hour_start,
        "notes":                  None,
    }
```

- [ ] **Step 5: Update the response-building code in both generate endpoints**

In `generate_recommendation` and `generate_all_recommendations`, the dict-return per row must include the new fields. Replace each existing response dict with a helper. Add this at module level just above the endpoints:

```python
def _rec_to_response(rec: models.Recommendation, intersection_name: str) -> dict:
    return {
        "id": rec.id,
        "intersection_id": rec.intersection_id,
        "intersection_name": intersection_name,
        "warrant_1_met": rec.warrant_1_met,
        "warrant_1_confidence": rec.warrant_1_confidence,
        "warrant_2_met": rec.warrant_2_met,
        "warrant_2_confidence": rec.warrant_2_confidence,
        "warrant_4_met": rec.warrant_4_met,
        "warrant_4_confidence": rec.warrant_4_confidence,
        "recommended": rec.recommended,
        "recommended_confidence": rec.recommended_confidence,
        "major_volume": rec.major_volume,
        "minor_volume": rec.minor_volume,
        "peds": rec.peds,
        "vpm": rec.vpm,
        "phf": rec.phf,
        "hour_start": rec.hour_start.isoformat() if rec.hour_start else None,
        "notes": rec.notes,
        "generated_at": rec.generated_at.isoformat(),
    }
```

Replace the return dicts in `generate_recommendation`, `generate_all_recommendations`, `update_notes`, and the `list_recommendations` row-dict construction with calls to `_rec_to_response(rec, intersection_name)`. (The list endpoint is fully rewritten in Task 5.)

- [ ] **Step 6: Run the test, verify pass**

Run: `pytest tests/test_recommendations.py::test_generate_returns_structured_fields -v`
Expected: PASS.

- [ ] **Step 7: Run the full test file to confirm no regression**

Run: `pytest tests/test_recommendations.py -v`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add server/routers/recommendations.py tests/test_recommendations.py
git commit -m "feat: return structured metric fields from warrant analysis"
```

---

## Task 4: Insert (don't replace) on regenerate

**Files:**
- Modify: `server/routers/recommendations.py` (`generate_recommendation`, `generate_all_recommendations`)
- Test reference: `tests/test_recommendations.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_recommendations.py`:

```python
def test_generate_inserts_does_not_replace(auth, db):
    """Regenerating must keep the prior recommendation row, not delete it."""
    from common.models import Recommendation

    iid = _first_intersection_id(auth)

    # Snapshot count before
    before = db.query(Recommendation).filter(Recommendation.intersection_id == iid).count()

    # Generate twice
    r1 = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    assert r1.status_code == 200
    r2 = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    assert r2.status_code == 200

    db.expire_all()  # refresh from DB
    after = db.query(Recommendation).filter(Recommendation.intersection_id == iid).count()
    assert after == before + 2, f"Expected +2 rows, got {after - before}"

    # The two responses are different rows
    assert r1.json()["id"] != r2.json()["id"]
```

- [ ] **Step 2: Run and verify it fails**

Run: `pytest tests/test_recommendations.py::test_generate_inserts_does_not_replace -v`
Expected: FAIL — `after == before + 1`, since the old code deletes-then-inserts.

- [ ] **Step 3: Drop the delete-then-insert in `generate_recommendation`**

Replace the body of `generate_recommendation` in `server/routers/recommendations.py`:

```python
@router.post("/generate/{intersection_id}", response_model=RecommendationResponse)
def generate_recommendation(
    intersection_id: int,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis for one intersection and insert a new row."""
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    analysis = _analyze(intersection_id, request.app.state.warrant_artifacts, db)

    rec = models.Recommendation(intersection_id=intersection_id, **analysis)
    db.add(rec)
    db.commit()
    db.refresh(rec)

    return _rec_to_response(rec, intersection.name)
```

- [ ] **Step 4: Drop the delete-then-insert in `generate_all_recommendations`**

Replace the body:

```python
@router.post("/generate-all", response_model=list[RecommendationResponse])
def generate_all_recommendations(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis for every intersection — inserts a new row per intersection."""
    intersections = db.query(models.Intersection).all()
    results = []

    artifacts = request.app.state.warrant_artifacts
    for intersection in intersections:
        analysis = _analyze(intersection.id, artifacts, db)
        rec = models.Recommendation(intersection_id=intersection.id, **analysis)
        db.add(rec)
        db.flush()
        db.refresh(rec)
        results.append(_rec_to_response(rec, intersection.name))

    db.commit()
    return results
```

- [ ] **Step 5: Run the test, verify pass**

Run: `pytest tests/test_recommendations.py::test_generate_inserts_does_not_replace -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routers/recommendations.py tests/test_recommendations.py
git commit -m "feat: insert (not replace) recommendation rows on regenerate"
```

---

## Task 5: List endpoint returns latest per intersection

**Files:**
- Modify: `server/routers/recommendations.py` (`list_recommendations`)
- Test reference: `tests/test_recommendations.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_recommendations.py`:

```python
def test_list_returns_one_row_per_intersection(auth):
    """After regenerating, GET / returns exactly one row per intersection (the latest)."""
    iid = _first_intersection_id(auth)
    # Generate twice so there are at least two rows for this intersection
    auth.post(f"{API_URL}/recommendations/generate/{iid}")
    r2 = auth.post(f"{API_URL}/recommendations/generate/{iid}")
    latest_id = r2.json()["id"]

    listing = auth.get(f"{API_URL}/recommendations/")
    assert listing.status_code == 200
    rows = listing.json()

    rows_for_iid = [r for r in rows if r["intersection_id"] == iid]
    assert len(rows_for_iid) == 1, f"Expected 1 row for intersection {iid}, got {len(rows_for_iid)}"
    assert rows_for_iid[0]["id"] == latest_id
```

- [ ] **Step 2: Run and verify it fails**

Run: `pytest tests/test_recommendations.py::test_list_returns_one_row_per_intersection -v`
Expected: FAIL — `len(rows_for_iid) > 1` after Task 4 dropped the delete behavior.

- [ ] **Step 3: Rewrite the list endpoint to use `DISTINCT ON`**

Replace `list_recommendations` in `server/routers/recommendations.py`:

```python
@router.get("/", response_model=list[RecommendationResponse])
def list_recommendations(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Return the latest recommendation per intersection."""
    rows = db.execute(text("""
        SELECT DISTINCT ON (r.intersection_id)
            r.id, r.intersection_id, i.name AS intersection_name,
            r.warrant_1_met, r.warrant_1_confidence,
            r.warrant_2_met, r.warrant_2_confidence,
            r.warrant_4_met, r.warrant_4_confidence,
            r.recommended, r.recommended_confidence,
            r.major_volume, r.minor_volume, r.peds, r.vpm, r.phf,
            r.hour_start, r.notes, r.generated_at
        FROM recommendations r
        JOIN intersections i ON i.id = r.intersection_id
        ORDER BY r.intersection_id, r.generated_at DESC
    """)).fetchall()

    return [
        {
            "id": r.id,
            "intersection_id": r.intersection_id,
            "intersection_name": r.intersection_name,
            "warrant_1_met": r.warrant_1_met,
            "warrant_1_confidence": r.warrant_1_confidence,
            "warrant_2_met": r.warrant_2_met,
            "warrant_2_confidence": r.warrant_2_confidence,
            "warrant_4_met": r.warrant_4_met,
            "warrant_4_confidence": r.warrant_4_confidence,
            "recommended": r.recommended,
            "recommended_confidence": r.recommended_confidence,
            "major_volume": r.major_volume,
            "minor_volume": r.minor_volume,
            "peds": r.peds,
            "vpm": r.vpm,
            "phf": r.phf,
            "hour_start": r.hour_start.isoformat() if r.hour_start else None,
            "notes": r.notes,
            "generated_at": r.generated_at.isoformat(),
        }
        for r in rows
    ]
```

- [ ] **Step 4: Run the test, verify pass**

Run: `pytest tests/test_recommendations.py::test_list_returns_one_row_per_intersection -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routers/recommendations.py tests/test_recommendations.py
git commit -m "feat: GET /recommendations/ returns latest per intersection via DISTINCT ON"
```

---

## Task 6: Add `GET /recommendations/history/{intersection_id}` endpoint

**Files:**
- Modify: `server/routers/recommendations.py`
- Test reference: `tests/test_recommendations.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_recommendations.py`:

```python
def test_history_endpoint_returns_descending_with_limit(auth):
    """GET /recommendations/history/{id} returns rows newest-first, capped by limit."""
    iid = _first_intersection_id(auth)
    # Make sure there are at least 3 rows
    for _ in range(3):
        auth.post(f"{API_URL}/recommendations/generate/{iid}")

    r = auth.get(f"{API_URL}/recommendations/history/{iid}?limit=2")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert isinstance(rows, list)
    assert len(rows) == 2
    # Descending by generated_at
    from datetime import datetime
    ts = [datetime.fromisoformat(row["generated_at"].replace("Z", "+00:00")) for row in rows]
    assert ts[0] >= ts[1]
    # Required structured fields present
    assert "major_volume" in rows[0]
    assert "recommended_confidence" in rows[0]


def test_history_limit_clamped(auth):
    """limit above 200 is clamped to 200."""
    iid = _first_intersection_id(auth)
    r = auth.get(f"{API_URL}/recommendations/history/{iid}?limit=9999")
    assert r.status_code == 200
    assert len(r.json()) <= 200
```

- [ ] **Step 2: Run and verify they fail**

Run: `pytest tests/test_recommendations.py::test_history_endpoint_returns_descending_with_limit tests/test_recommendations.py::test_history_limit_clamped -v`
Expected: both FAIL with 404 (endpoint missing).

- [ ] **Step 3: Add the endpoint**

Append to `server/routers/recommendations.py` (after `update_notes`):

```python
@router.get("/history/{intersection_id}", response_model=list[RecommendationResponse])
def list_history(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
    limit: int = 50,
):
    """Return all recommendation runs for an intersection, newest first."""
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    limit = max(1, min(limit, 200))

    rows = (
        db.query(models.Recommendation)
        .filter(models.Recommendation.intersection_id == intersection_id)
        .order_by(models.Recommendation.generated_at.desc())
        .limit(limit)
        .all()
    )
    return [_rec_to_response(rec, intersection.name) for rec in rows]
```

- [ ] **Step 4: Run the tests, verify pass**

Run: `pytest tests/test_recommendations.py::test_history_endpoint_returns_descending_with_limit tests/test_recommendations.py::test_history_limit_clamped -v`
Expected: both PASS.

- [ ] **Step 5: Run the full test file to confirm no regression**

Run: `pytest tests/test_recommendations.py -v`
Expected: every test PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routers/recommendations.py tests/test_recommendations.py
git commit -m "feat: add GET /recommendations/history/{intersection_id} endpoint"
```

---

## Task 7: Frontend foundations — types, service, status bucket helper

**Files:**
- Modify: `eyegila/src/types/index.ts`
- Modify: `eyegila/src/services/recommendations.ts`
- Create: `eyegila/src/components/recommendations/statusBucket.ts`

- [ ] **Step 1: Extend the `Recommendation` type**

Edit `eyegila/src/types/index.ts`, replace the `Recommendation` interface:

```ts
export interface Recommendation {
  id: number;
  intersection_id: number;
  warrant_1_met: boolean;
  warrant_1_confidence: number;
  warrant_2_met: boolean;
  warrant_2_confidence: number;
  warrant_4_met: boolean;
  warrant_4_confidence: number;
  recommended: boolean;
  recommended_confidence: number | null;
  major_volume: number | null;
  minor_volume: number | null;
  peds: number | null;
  vpm: number | null;
  phf: number | null;
  hour_start: string | null;
  notes: string | null;
  generated_at: string;
}
```

- [ ] **Step 2: Add `history()` to the recommendations service**

Edit `eyegila/src/services/recommendations.ts`, replace its contents:

```ts
import { request } from './api';
import type { Recommendation } from '@/types';

export interface RecommendationResponse extends Recommendation {
  intersection_name: string;
}

export const recommendationsApi = {
  list(): Promise<RecommendationResponse[]> {
    return request('/recommendations/');
  },
  generate(intersectionId: number): Promise<RecommendationResponse> {
    return request(`/recommendations/generate/${intersectionId}`, { method: 'POST' });
  },
  generateAll(): Promise<RecommendationResponse[]> {
    return request('/recommendations/generate-all', { method: 'POST' });
  },
  history(intersectionId: number, limit = 50): Promise<RecommendationResponse[]> {
    return request(`/recommendations/history/${intersectionId}?limit=${limit}`);
  },
  updateNotes(id: number, notes: string | null): Promise<RecommendationResponse> {
    return request(`/recommendations/${id}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    });
  },
};
```

Note: the `Content-Type: application/json` header is set automatically by `request()` when body is not FormData; the old explicit header was redundant.

- [ ] **Step 3: Create the status-bucket helper**

Create `eyegila/src/components/recommendations/statusBucket.ts`:

```ts
import type { RecommendationResponse } from '@/services/recommendations';

export type StatusBucket = 'warranted' | 'borderline' | 'not_warranted' | 'no_data';

const BORDERLINE_LOW = 0.3;
const BORDERLINE_HIGH = 0.5;

/** Classify a recommendation into one of four triage buckets.
 * `hour_start === null` covers rows written before the migration.
 * The triple-zero check covers the empty-data short-circuit. */
export function statusBucket(rec: RecommendationResponse): StatusBucket {
  if (
    rec.hour_start === null ||
    ((rec.major_volume ?? 0) === 0 && (rec.minor_volume ?? 0) === 0 && (rec.peds ?? 0) === 0)
  ) {
    return 'no_data';
  }
  if (rec.recommended) return 'warranted';
  const confs = [rec.warrant_1_confidence, rec.warrant_2_confidence, rec.warrant_4_confidence];
  if (confs.some(c => c >= BORDERLINE_LOW && c < BORDERLINE_HIGH)) return 'borderline';
  return 'not_warranted';
}

export const BUCKET_LABEL: Record<StatusBucket, string> = {
  warranted: 'Warranted',
  borderline: 'Borderline',
  not_warranted: 'Not warranted',
  no_data: 'No data',
};

export const BUCKET_BADGE_CLASS: Record<StatusBucket, string> = {
  warranted:     'border-emerald-500/40 text-emerald-700 bg-emerald-50',
  borderline:    'border-amber-500/40 text-amber-700 bg-amber-50',
  not_warranted: 'border-muted text-muted-foreground bg-muted/40',
  no_data:       'border-rose-500/40 text-rose-700 bg-rose-50',
};
```

- [ ] **Step 4: Type-check**

Run: `cd eyegila && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add eyegila/src/types/index.ts eyegila/src/services/recommendations.ts eyegila/src/components/recommendations/statusBucket.ts
git commit -m "feat(fe): extend Recommendation type, add history() and status bucket helper"
```

---

## Task 8: `SummaryStrip` component

**Files:**
- Create: `eyegila/src/components/recommendations/SummaryStrip.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { type StatusBucket, BUCKET_LABEL } from './statusBucket';

interface Props {
  counts: Record<StatusBucket, number>;
  totalIntersections: number;
}

const ORDER: StatusBucket[] = ['warranted', 'borderline', 'not_warranted', 'no_data'];

const COLOR: Record<StatusBucket, string> = {
  warranted: 'text-emerald-600',
  borderline: 'text-amber-600',
  not_warranted: 'text-foreground',
  no_data: 'text-rose-600',
};

export function SummaryStrip({ counts, totalIntersections }: Props) {
  const analyzed = ORDER.reduce((s, k) => s + counts[k], 0);
  const notAnalyzed = totalIntersections - analyzed;

  return (
    <div className="flex flex-wrap gap-6 rounded-lg border border-border bg-card px-5 py-3 text-sm">
      {ORDER.map(k => (
        <div key={k} className="flex items-center gap-1.5">
          <span className={`text-lg font-bold tabular-nums ${COLOR[k]}`}>{counts[k]}</span>
          <span className="text-muted-foreground">{BUCKET_LABEL[k].toLowerCase()}</span>
        </div>
      ))}
      {notAnalyzed > 0 && (
        <div className="ml-auto text-xs text-muted-foreground">
          {notAnalyzed} intersection{notAnalyzed === 1 ? '' : 's'} not yet analyzed
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd eyegila && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add eyegila/src/components/recommendations/SummaryStrip.tsx
git commit -m "feat(fe): add SummaryStrip component for recommendations triage"
```

---

## Task 9: `FilterBar` component

**Files:**
- Create: `eyegila/src/components/recommendations/FilterBar.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type StatusBucket, BUCKET_LABEL } from './statusBucket';

export type WarrantKey = 'warrant_1' | 'warrant_2' | 'warrant_4';

export interface FilterState {
  statuses: Set<StatusBucket>;
  search: string;
  warrants: Set<WarrantKey>;
  minProb: number;
}

export const ALL_STATUSES: StatusBucket[] = ['warranted', 'borderline', 'not_warranted', 'no_data'];
export const ALL_WARRANTS: WarrantKey[] = ['warrant_1', 'warrant_2', 'warrant_4'];

interface Props {
  value: FilterState;
  onChange: (next: FilterState) => void;
}

export function FilterBar({ value, onChange }: Props) {
  function toggleStatus(s: StatusBucket) {
    const next = new Set(value.statuses);
    if (next.has(s)) next.delete(s); else next.add(s);
    onChange({ ...value, statuses: next });
  }
  function toggleWarrant(w: WarrantKey) {
    const next = new Set(value.warrants);
    if (next.has(w)) next.delete(w); else next.add(w);
    onChange({ ...value, warrants: next });
  }
  const sliderDisabled = value.warrants.size === 0;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-1.5">
        {ALL_STATUSES.map(s => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={value.statuses.has(s) ? 'default' : 'outline'}
            className="h-7 px-2.5 text-xs"
            onClick={() => toggleStatus(s)}
          >
            {BUCKET_LABEL[s]}
          </Button>
        ))}
      </div>

      <div className="h-5 w-px bg-border" />

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase text-muted-foreground tracking-wide">Warrant</span>
        {ALL_WARRANTS.map(w => (
          <Button
            key={w}
            type="button"
            size="sm"
            variant={value.warrants.has(w) ? 'default' : 'outline'}
            className="h-7 px-2.5 text-xs"
            onClick={() => toggleWarrant(w)}
          >
            {w === 'warrant_1' ? 'W1' : w === 'warrant_2' ? 'W2' : 'W4'}
          </Button>
        ))}
      </div>

      <div className={cn('flex items-center gap-2', sliderDisabled && 'opacity-50')}>
        <span className="text-[10px] uppercase text-muted-foreground tracking-wide">Min prob</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value.minProb}
          disabled={sliderDisabled}
          onChange={e => onChange({ ...value, minProb: Number(e.target.value) })}
          className="w-28 accent-foreground"
        />
        <span className="text-xs tabular-nums w-8 text-right">{value.minProb.toFixed(2)}</span>
      </div>

      <Input
        placeholder="Search intersections…"
        value={value.search}
        onChange={e => onChange({ ...value, search: e.target.value })}
        className="ml-auto h-7 max-w-[220px] text-xs"
      />
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd eyegila && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add eyegila/src/components/recommendations/FilterBar.tsx
git commit -m "feat(fe): add FilterBar with status, warrant, min-prob, and name filters"
```

---

## Task 10: `RecommendationsTable` component

**Files:**
- Create: `eyegila/src/components/recommendations/RecommendationsTable.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { type RecommendationResponse } from '@/services/recommendations';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CheckCircle2, RefreshCw, Loader2, ArrowUp, ArrowDown } from 'lucide-react';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from './statusBucket';

export type SortKey =
  | 'name' | 'status'
  | 'w1' | 'w2' | 'w4'
  | 'major' | 'peds' | 'generated';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

interface Props {
  rows: RecommendationResponse[];
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  onRowClick: (rec: RecommendationResponse) => void;
  onRegenerate: (intersectionId: number) => void;
  regeneratingIds: Set<number>;
}

const STATUS_ORDER: Record<ReturnType<typeof statusBucket>, number> = {
  warranted: 0, borderline: 1, not_warranted: 2, no_data: 3,
};

export function RecommendationsTable({
  rows, sort, onSortChange, onRowClick, onRegenerate, regeneratingIds,
}: Props) {
  function toggleSort(key: SortKey) {
    if (sort.key === key) onSortChange({ key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    else onSortChange({ key, dir: key === 'name' ? 'asc' : 'desc' });
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <Th label="Intersection"  k="name"      sort={sort} onClick={toggleSort} />
            <Th label="Status"        k="status"    sort={sort} onClick={toggleSort} />
            <Th label="W1"            k="w1"        sort={sort} onClick={toggleSort} numeric />
            <Th label="W2"            k="w2"        sort={sort} onClick={toggleSort} numeric />
            <Th label="W4"            k="w4"        sort={sort} onClick={toggleSort} numeric />
            <Th label="Major /hr"     k="major"     sort={sort} onClick={toggleSort} numeric />
            <Th label="Peds /hr"      k="peds"      sort={sort} onClick={toggleSort} numeric />
            <Th label="Generated"     k="generated" sort={sort} onClick={toggleSort} />
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(rec => {
            const bucket = statusBucket(rec);
            const isRegenerating = regeneratingIds.has(rec.intersection_id);
            return (
              <TableRow
                key={rec.id}
                onClick={() => onRowClick(rec)}
                className="cursor-pointer hover:bg-muted/40"
              >
                <TableCell className="font-medium">{rec.intersection_name}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn('text-[10px]', BUCKET_BADGE_CLASS[bucket])}>
                    {BUCKET_LABEL[bucket]}
                  </Badge>
                </TableCell>
                <ProbCell met={rec.warrant_1_met} value={rec.warrant_1_confidence} />
                <ProbCell met={rec.warrant_2_met} value={rec.warrant_2_confidence} />
                <ProbCell met={rec.warrant_4_met} value={rec.warrant_4_confidence} />
                <NumCell value={rec.major_volume} />
                <NumCell value={rec.peds} />
                <TableCell className="text-xs text-muted-foreground" title={new Date(rec.generated_at).toLocaleString()}>
                  {relativeTime(rec.generated_at)}
                </TableCell>
                <TableCell onClick={e => e.stopPropagation()}>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label="Regenerate"
                    disabled={isRegenerating}
                    onClick={() => onRegenerate(rec.intersection_id)}
                  >
                    {isRegenerating
                      ? <Loader2 className="size-3.5 animate-spin" />
                      : <RefreshCw className="size-3.5" />}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function Th({
  label, k, sort, onClick, numeric,
}: {
  label: string; k: SortKey; sort: SortState; onClick: (k: SortKey) => void; numeric?: boolean;
}) {
  const active = sort.key === k;
  return (
    <TableHead
      onClick={() => onClick(k)}
      className={cn('cursor-pointer select-none whitespace-nowrap', numeric && 'text-right')}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </span>
    </TableHead>
  );
}

function ProbCell({ met, value }: { met: boolean; value: number }) {
  return (
    <TableCell className={cn('text-right tabular-nums', met ? 'text-emerald-600 font-semibold' : 'text-muted-foreground')}>
      <span className="inline-flex items-center gap-1 justify-end">
        {met && <CheckCircle2 className="size-3" />}
        {value.toFixed(2)}
      </span>
    </TableCell>
  );
}

function NumCell({ value }: { value: number | null }) {
  return (
    <TableCell className="text-right tabular-nums text-muted-foreground">
      {value ?? '—'}
    </TableCell>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function sortRows(rows: RecommendationResponse[], sort: SortState): RecommendationResponse[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'name':      return sign * a.intersection_name.localeCompare(b.intersection_name);
      case 'status': {
        const cmp = STATUS_ORDER[statusBucket(a)] - STATUS_ORDER[statusBucket(b)];
        if (cmp !== 0) return sign * cmp;
        // Spec tiebreaker: recommended_confidence descending within a status bucket
        return (b.recommended_confidence ?? 0) - (a.recommended_confidence ?? 0);
      }
      case 'w1':        return sign * (a.warrant_1_confidence - b.warrant_1_confidence);
      case 'w2':        return sign * (a.warrant_2_confidence - b.warrant_2_confidence);
      case 'w4':        return sign * (a.warrant_4_confidence - b.warrant_4_confidence);
      case 'major':     return sign * ((a.major_volume ?? -1) - (b.major_volume ?? -1));
      case 'peds':      return sign * ((a.peds ?? -1) - (b.peds ?? -1));
      case 'generated': return sign * (new Date(a.generated_at).getTime() - new Date(b.generated_at).getTime());
    }
  });
}
```

- [ ] **Step 2: Type-check**

Run: `cd eyegila && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add eyegila/src/components/recommendations/RecommendationsTable.tsx
git commit -m "feat(fe): add sortable RecommendationsTable with status badges and inline regenerate"
```

---

## Task 11: `LatestTab` component

**Files:**
- Create: `eyegila/src/components/recommendations/LatestTab.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useState } from 'react';
import { toast } from 'sonner';
import { type RecommendationResponse, recommendationsApi } from '@/services/recommendations';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Loader2, RefreshCw, Pencil, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  rec: RecommendationResponse;
  onRegenerate: () => void;
  regenerating: boolean;
  onNotesSaved: (rec: RecommendationResponse) => void;
}

const BARS: { key: 'warrant_1' | 'warrant_2' | 'warrant_4' | 'recommended'; label: string }[] = [
  { key: 'warrant_1',  label: 'W1 — Eight-Hour Vehicular Volume' },
  { key: 'warrant_2',  label: 'W2 — Four-Hour Vehicular Volume' },
  { key: 'warrant_4',  label: 'W4 — Pedestrian Volume' },
  { key: 'recommended',label: 'Overall recommended' },
];

export function LatestTab({ rec, onRegenerate, regenerating, onNotesSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rec.notes ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const updated = await recommendationsApi.updateNotes(rec.id, draft.trim() || null);
      onNotesSaved(updated);
      setEditing(false);
      toast.success('Notes saved');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Hour analyzed: <span className="text-foreground">
            {rec.hour_start ? new Date(rec.hour_start).toLocaleString() : 'unknown'}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={onRegenerate} disabled={regenerating}>
          {regenerating
            ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            : <RefreshCw className="size-3.5 mr-1.5" />}
          Regenerate
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {BARS.map(b => {
          const value = b.key === 'recommended'
            ? (rec.recommended_confidence ?? 0)
            : rec[`${b.key}_confidence` as `warrant_1_confidence`];
          const met = b.key === 'recommended'
            ? rec.recommended
            : rec[`${b.key}_met` as `warrant_1_met`];
          return (
            <div key={b.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className={cn(met && 'font-semibold')}>{b.label}</span>
                <span className="tabular-nums text-muted-foreground">{(value * 100).toFixed(0)}%</span>
              </div>
              <Progress
                value={value * 100}
                className={cn('h-2', met ? '[&>div]:bg-emerald-500' : '[&>div]:bg-muted-foreground/40')}
              />
            </div>
          );
        })}
      </div>

      <Separator />

      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Feature inputs (last hour)</div>
        <div className="grid grid-cols-5 gap-3 text-center">
          <Stat label="Major" value={rec.major_volume} suffix="veh/hr" />
          <Stat label="Minor" value={rec.minor_volume} suffix="veh/hr" />
          <Stat label="Peds"  value={rec.peds}         suffix="/hr" />
          <Stat label="VPM"   value={rec.vpm}          suffix="" />
          <Stat label="PHF"   value={rec.phf}          suffix="" digits={2} />
        </div>
      </div>

      <Separator />

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Engineer notes</div>
          {!editing && (
            <Button size="icon" variant="ghost" className="size-6" onClick={() => { setDraft(rec.notes ?? ''); setEditing(true); }} aria-label="Edit notes">
              <Pencil className="size-3" />
            </Button>
          )}
        </div>
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="Engineer notes…"
              className="text-xs min-h-[100px]"
              autoFocus
            />
            <div className="flex gap-1.5 justify-end">
              <Button size="icon" variant="ghost" className="size-6" onClick={() => setEditing(false)} disabled={saving} aria-label="Cancel">
                <X className="size-3" />
              </Button>
              <Button size="icon" variant="ghost" className="size-6 text-emerald-600" onClick={save} disabled={saving} aria-label="Save">
                {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              </Button>
            </div>
          </div>
        ) : (
          <p className={cn('text-xs leading-relaxed', rec.notes ? 'text-foreground' : 'text-muted-foreground/60 italic')}>
            {rec.notes ?? 'No notes'}
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, suffix, digits = 0 }: { label: string; value: number | null; suffix: string; digits?: number }) {
  return (
    <div className="rounded-md border border-border bg-card px-2 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">
        {value === null ? '—' : digits ? value.toFixed(digits) : value}
      </div>
      {suffix && <div className="text-[9px] text-muted-foreground">{suffix}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd eyegila && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add eyegila/src/components/recommendations/LatestTab.tsx
git commit -m "feat(fe): add LatestTab with probability bars, feature stats, notes editor"
```

---

## Task 12: `HistoryTab` component

**Files:**
- Create: `eyegila/src/components/recommendations/HistoryTab.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type RecommendationResponse, recommendationsApi } from '@/services/recommendations';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface Props {
  intersectionId: number;
  /** Optionally seed with rows pushed in from the parent (e.g. after regenerate). */
  seed?: RecommendationResponse[];
}

export function HistoryTab({ intersectionId, seed }: Props) {
  const [rows, setRows] = useState<RecommendationResponse[] | null>(seed ?? null);
  const [loading, setLoading] = useState(seed === undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (rows !== null) return;
    let cancelled = false;
    setLoading(true);
    recommendationsApi.history(intersectionId, 50)
      .then(r => { if (!cancelled) { setRows(r); setError(null); } })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load history'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [intersectionId, rows]);

  if (loading) return <div className="flex flex-col gap-2"><Skeleton className="h-40" /><Skeleton className="h-20" /></div>;
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 text-xs">
        <p className="text-rose-600">{error}</p>
        <Button size="sm" variant="outline" onClick={() => { setRows(null); setError(null); }}>Retry</Button>
      </div>
    );
  }
  if (!rows || rows.length === 0) return <p className="text-xs text-muted-foreground">No history yet.</p>;

  // recharts wants ascending order
  const chartData = [...rows].reverse().map(r => ({
    ts: new Date(r.generated_at).getTime(),
    W1: r.warrant_1_confidence,
    W2: r.warrant_2_confidence,
    W4: r.warrant_4_confidence,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="h-44 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              fontSize={9}
            />
            <YAxis domain={[0, 1]} fontSize={9} />
            <Tooltip
              labelFormatter={t => new Date(t as number).toLocaleString()}
              formatter={(v: number) => v.toFixed(2)}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Line type="monotone" dataKey="W1" stroke="#0ea5e9" dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="W2" stroke="#10b981" dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="W4" stroke="#f59e0b" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-col divide-y divide-border border border-border rounded-md">
        {rows.map(r => <HistoryRow key={r.id} rec={r} />)}
      </div>
    </div>
  );
}

function HistoryRow({ rec }: { rec: RecommendationResponse }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        type="button"
        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-muted/40"
        onClick={() => setOpen(o => !o)}
      >
        <span className="flex items-center gap-1.5">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <span className="font-medium">{new Date(rec.generated_at).toLocaleString()}</span>
        </span>
        <span className="tabular-nums text-muted-foreground">
          W1 {rec.warrant_1_confidence.toFixed(2)} · W2 {rec.warrant_2_confidence.toFixed(2)} · W4 {rec.warrant_4_confidence.toFixed(2)}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 grid grid-cols-5 gap-2 text-[11px]">
          <Cell label="Major" v={rec.major_volume} />
          <Cell label="Minor" v={rec.minor_volume} />
          <Cell label="Peds"  v={rec.peds} />
          <Cell label="VPM"   v={rec.vpm} />
          <Cell label="PHF"   v={rec.phf !== null ? rec.phf.toFixed(2) : null} />
          {rec.notes && (
            <div className="col-span-5 mt-1 text-muted-foreground italic">"{rec.notes}"</div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ label, v }: { label: string; v: number | string | null }) {
  return (
    <div>
      <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
      <div className="tabular-nums">{v ?? '—'}</div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd eyegila && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add eyegila/src/components/recommendations/HistoryTab.tsx
git commit -m "feat(fe): add HistoryTab with trend chart and collapsible run list"
```

---

## Task 13: `DetailSheet` component

**Files:**
- Create: `eyegila/src/components/recommendations/DetailSheet.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useState, useEffect } from 'react';
import { type RecommendationResponse } from '@/services/recommendations';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LatestTab } from './LatestTab';
import { HistoryTab } from './HistoryTab';

interface Props {
  rec: RecommendationResponse | null;
  onClose: () => void;
  onRegenerate: (intersectionId: number) => Promise<RecommendationResponse | null>;
  regenerating: boolean;
  onNotesSaved: (rec: RecommendationResponse) => void;
}

export function DetailSheet({ rec, onClose, onRegenerate, regenerating, onNotesSaved }: Props) {
  const [tab, setTab] = useState<'latest' | 'history'>('latest');
  const [historySeed, setHistorySeed] = useState<RecommendationResponse[] | undefined>(undefined);

  // Reset tab + seed whenever the user opens a different intersection
  useEffect(() => {
    if (rec) {
      setTab('latest');
      setHistorySeed(undefined);
    }
  }, [rec?.intersection_id]);

  async function handleRegenerate() {
    if (!rec) return;
    const fresh = await onRegenerate(rec.intersection_id);
    if (fresh) setHistorySeed(prev => (prev ? [fresh, ...prev] : undefined));
  }

  return (
    <Sheet open={rec !== null} onOpenChange={open => !open && onClose()}>
      <SheetContent side="right" className="w-[480px] sm:max-w-[520px] overflow-y-auto">
        {rec && (
          <>
            <SheetHeader>
              <SheetTitle>{rec.intersection_name}</SheetTitle>
              <SheetDescription>Warrant analysis details</SheetDescription>
            </SheetHeader>

            <Tabs value={tab} onValueChange={v => setTab(v as 'latest' | 'history')} className="mt-4">
              <TabsList className="grid grid-cols-2">
                <TabsTrigger value="latest">Latest</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
              <TabsContent value="latest" className="mt-4">
                <LatestTab
                  rec={rec}
                  onRegenerate={handleRegenerate}
                  regenerating={regenerating}
                  onNotesSaved={onNotesSaved}
                />
              </TabsContent>
              <TabsContent value="history" className="mt-4">
                <HistoryTab intersectionId={rec.intersection_id} seed={historySeed} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd eyegila && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add eyegila/src/components/recommendations/DetailSheet.tsx
git commit -m "feat(fe): add DetailSheet that hosts Latest and History tabs"
```

---

## Task 14: Rewrite `RecommendationsPage` and wire everything together

**Files:**
- Modify: `eyegila/src/pages/Recommendations.tsx` (full rewrite)

- [ ] **Step 1: Replace the page**

Replace the entire contents of `eyegila/src/pages/Recommendations.tsx`:

```tsx
import { useEffect, useMemo, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { intersectionsApi } from '@/services/intersections';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import type { Intersection } from '@/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, RefreshCw, Lightbulb } from 'lucide-react';
import { SummaryStrip } from '@/components/recommendations/SummaryStrip';
import { FilterBar, type FilterState, ALL_STATUSES, ALL_WARRANTS } from '@/components/recommendations/FilterBar';
import { RecommendationsTable, sortRows, type SortState } from '@/components/recommendations/RecommendationsTable';
import { DetailSheet } from '@/components/recommendations/DetailSheet';
import { statusBucket, type StatusBucket } from '@/components/recommendations/statusBucket';

export function RecommendationsPage() {
  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [recs, setRecs] = useState<RecommendationResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [regeneratingIds, setRegeneratingIds] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [filter, setFilter] = useState<FilterState>({
    statuses: new Set(ALL_STATUSES),
    search: '',
    warrants: new Set(),
    minProb: 0,
  });
  const [sort, setSort] = useState<SortState>({ key: 'status', dir: 'asc' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ints, r] = await Promise.all([
        intersectionsApi.list(),
        recommendationsApi.list(),
      ]);
      setIntersections(ints);
      setRecs(r);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function regenerateOne(intersectionId: number): Promise<RecommendationResponse | null> {
    setRegeneratingIds(prev => new Set(prev).add(intersectionId));
    try {
      const fresh = await recommendationsApi.generate(intersectionId);
      setRecs(prev => {
        const without = prev.filter(r => r.intersection_id !== intersectionId);
        return [...without, fresh];
      });
      toast.success('Analysis complete');
      return fresh;
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
      return null;
    } finally {
      setRegeneratingIds(prev => {
        const s = new Set(prev);
        s.delete(intersectionId);
        return s;
      });
    }
  }

  async function regenerateAll() {
    setGeneratingAll(true);
    try {
      const results = await recommendationsApi.generateAll();
      setRecs(results);
      const warranted = results.filter(r => r.recommended).length;
      toast.success(`Analysis complete — ${warranted} warranted`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setGeneratingAll(false);
    }
  }

  function onNotesSaved(updated: RecommendationResponse) {
    setRecs(prev => prev.map(r => (r.id === updated.id ? updated : r)));
  }

  // Filtered + sorted rows for the table
  const visibleRows = useMemo(() => {
    const filtered = recs.filter(r => {
      // status
      if (!filter.statuses.has(statusBucket(r))) return false;
      // name search
      if (filter.search && !r.intersection_name.toLowerCase().includes(filter.search.toLowerCase())) return false;
      // warrant + minProb
      if (filter.warrants.size > 0) {
        const fields: Record<typeof ALL_WARRANTS[number], number> = {
          warrant_1: r.warrant_1_confidence,
          warrant_2: r.warrant_2_confidence,
          warrant_4: r.warrant_4_confidence,
        };
        const ok = [...filter.warrants].some(w => fields[w] >= filter.minProb);
        if (!ok) return false;
      }
      return true;
    });
    return sortRows(filtered, sort);
  }, [recs, filter, sort]);

  const counts = useMemo<Record<StatusBucket, number>>(() => {
    const c = { warranted: 0, borderline: 0, not_warranted: 0, no_data: 0 };
    for (const r of recs) c[statusBucket(r)] += 1;
    return c;
  }, [recs]);

  const selectedRec = selectedId !== null ? recs.find(r => r.intersection_id === selectedId) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Recommendations</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            MUTCD signal warrant analysis — last full hour of detections
          </p>
        </div>
        <Button onClick={regenerateAll} disabled={generatingAll || loading || intersections.length === 0} size="sm">
          {generatingAll ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="size-3.5 mr-1.5" />}
          Run all
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm flex items-center justify-between">
          <span className="text-rose-600">{error}</span>
          <Button size="sm" variant="outline" onClick={load}>Retry</Button>
        </div>
      ) : loading ? (
        <Skeleton className="h-64" />
      ) : intersections.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
          <Lightbulb className="size-10 opacity-30" />
          <p className="text-sm">No intersections configured</p>
        </div>
      ) : (
        <>
          <SummaryStrip counts={counts} totalIntersections={intersections.length} />
          <FilterBar value={filter} onChange={setFilter} />
          {visibleRows.length > 0 ? (
            <RecommendationsTable
              rows={visibleRows}
              sort={sort}
              onSortChange={setSort}
              onRowClick={r => setSelectedId(r.intersection_id)}
              onRegenerate={iid => { regenerateOne(iid); }}
              regeneratingIds={regeneratingIds}
            />
          ) : (
            <div className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
              No intersections match the current filters.
            </div>
          )}
        </>
      )}

      <DetailSheet
        rec={selectedRec}
        onClose={() => setSelectedId(null)}
        onRegenerate={regenerateOne}
        regenerating={selectedId !== null && regeneratingIds.has(selectedId)}
        onNotesSaved={onNotesSaved}
      />
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd eyegila && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add eyegila/src/pages/Recommendations.tsx
git commit -m "feat(fe): rewrite Recommendations page around table + detail drawer"
```

---

## Task 15: Manual verification

**Files:** none modified — verifies behavior end-to-end.

- [ ] **Step 1: Start the stack**

```bash
docker compose -f docker-compose.mac.yml up -d
alembic upgrade head
python scripts/fake_detections.py --seed   # seed intersections
python scripts/fake_detections.py --hour-back  # produce detection data for last hour
cd eyegila && npm run dev
```

Open the URL printed by Vite (typically `http://localhost:5173`).

- [ ] **Step 2: Run full backend test suite**

Run: `pytest tests/test_recommendations.py -v`
Expected: all tests PASS.

- [ ] **Step 3: Manual checklist in the browser**

Walk through each item. Note any deviation; fix and re-test before checking off.

- [ ] Page loads. Summary strip shows four counts (Warranted/Borderline/Not warranted/No data).
- [ ] Click "Run all" — toast appears, table populates, intersections lacking data are bucketed as "No data".
- [ ] Each table column toggles between asc/desc on click. Sort icon shows on the active column.
- [ ] Status chips toggle inclusion (clicking "Warranted" filters out warranted rows when off).
- [ ] Name search filters in real time.
- [ ] Enabling a warrant chip enables the min-prob slider. Moving the slider correctly hides rows whose chosen warrant probability is below the threshold.
- [ ] Click a "No data" intersection's regenerate icon — the row updates after the toast. (Repeated regenerates add to the row's history list in the drawer.)
- [ ] Row click opens the drawer (right side). Default tab is Latest. Probability bars, feature stats, and notes editor render.
- [ ] Edit notes, save — value persists after closing/reopening the drawer.
- [ ] Switch to History tab — chart renders for intersections with multiple runs; collapsible rows show per-run features.
- [ ] Regenerate from inside the drawer — Latest tab refreshes, History tab includes the new run at the top of the chart and list.
- [ ] Close drawer, open a different intersection — its own data renders (no leak from the prior intersection's state).
- [ ] Close drawer, open the same intersection — history fetches again (cache is per-open-drawer).
- [ ] Reload the page — sort/filter state resets to defaults; data re-fetches cleanly.

- [ ] **Step 4: Commit nothing — just confirm in the conversation**

Manual verification produces no artifacts. Report back with the result.

---

## Self-Review

After completing all tasks above, look back at the spec and confirm:

- **Migration `0004`** present — Task 1.
- **`Recommendation` model extended** — Task 2.
- **`_analyze` returns structured fields, no auto-notes** — Task 3.
- **Generate endpoints insert (don't replace)** — Task 4.
- **List endpoint returns latest per intersection** — Task 5.
- **`GET /history/{id}?limit=` endpoint with clamp** — Task 6.
- **`RecommendationResponse` includes seven new fields** — Task 3.
- **Empty-data short-circuit still writes a row with zeros and `hour_start` set** — Task 3.
- **Frontend `Recommendation` type extended** — Task 7.
- **`recommendationsApi.history()`** — Task 7.
- **`statusBucket` helper with the spec's rules** — Task 7.
- **`SummaryStrip` / `FilterBar` / `RecommendationsTable` / `LatestTab` / `HistoryTab` / `DetailSheet`** — Tasks 8–13.
- **`RecommendationsPage` wired** — Task 14.
- **Backend tests covering the new behavior** — Tasks 3–6 (TDD pairs).
- **Manual frontend test plan** — Task 15.

If any of the above is missing after implementation, file a follow-up task before marking the plan complete.
