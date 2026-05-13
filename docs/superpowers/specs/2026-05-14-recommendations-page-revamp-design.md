# Recommendations Page Revamp — Design

**Date:** 2026-05-14
**Branch:** `jed/warrant-model`
**Status:** Approved, ready for implementation plan

## Goal

Redesign the `/recommendations` page in the React frontend so engineers can triage all intersections at a glance and drill into any one to see the warrant-model's inputs, outputs, and run history. Extend the backend to expose the model's feature inputs (Major/Minor/Peds/VPM/PHF), the `recommended_confidence` probability, and the hour the analysis covered, and to retain every run rather than overwriting on regeneration.

This builds on the warrant-MLP integration shipped in `2026-05-13-warrant-model-integration-design.md` — the model and inference pipeline stay the same; this change is about exposing the model's reasoning and run history through better data shape and UI.

## Non-goals

- No retraining or changes to the warrant model itself.
- No auto-refresh / polling — manual regenerate only.
- No bulk per-warrant regenerate, CSV export, or per-user note threads.
- No permission gating beyond the existing `get_current_user` dependency.
- No frontend test framework introduction; verification is manual + dev-server exercise.

## Backend changes

### Migration `0004_recommendations_metrics_and_history`

Adds the feature columns the model uses, the recommended-confidence probability, the hour the analysis covered, and an index for history queries. All new columns are nullable so existing rows survive.

```sql
ALTER TABLE recommendations
  ADD COLUMN major_volume INT,
  ADD COLUMN minor_volume INT,
  ADD COLUMN peds INT,
  ADD COLUMN vpm INT,
  ADD COLUMN phf FLOAT,
  ADD COLUMN recommended_confidence FLOAT,
  ADD COLUMN hour_start TIMESTAMPTZ;

CREATE INDEX ix_recommendations_intersection_generated
  ON recommendations (intersection_id, generated_at DESC);
```

### `common/models.Recommendation`

Add the same seven columns to the SQLAlchemy model with matching nullable types.

### `server/routers/recommendations.py`

- `_analyze(intersection_id, artifacts, db) -> dict` now returns a flat dict including the seven new fields (`major_volume`, `minor_volume`, `peds`, `vpm`, `phf`, `recommended_confidence`, `hour_start`) **and** `notes=None`. The auto-text formerly written into `notes` is dropped — its contents are now structured fields.
- `generate_recommendation` and `generate_all_recommendations` **stop deleting** the prior row. Every call inserts a new `Recommendation`.
- `GET /recommendations/` returns the latest row per intersection using `DISTINCT ON`:
  ```sql
  SELECT DISTINCT ON (r.intersection_id)
    r.*, i.name AS intersection_name
  FROM recommendations r
  JOIN intersections i ON i.id = r.intersection_id
  ORDER BY r.intersection_id, r.generated_at DESC
  ```
- New endpoint `GET /recommendations/history/{intersection_id}?limit=50` returns past runs in `generated_at DESC` order, capped at `limit` (default 50, max 200).
- `PATCH /{rec_id}/notes` is unchanged — it edits the row's `notes` field, which is now purely engineer text.

### `RecommendationResponse` (pydantic)

Add the seven new fields. `notes` stays `Optional[str]`. `hour_start` serialized as ISO 8601 or null.

### Empty-data short-circuit

When the most-recent-complete-hour has zero rows in `aggregation_summaries`, the analysis still inserts a row. All probabilities and feature counts are zero, `hour_start` is set to the hour analyzed, `notes` is null. The empty case is identifiable from `major_volume == 0 && minor_volume == 0 && peds == 0`. The frontend uses that triple-zero check for the "No data" badge (see status badge derivation below).

## Frontend changes

### Types — `eyegila/src/types/index.ts`

Extend `Recommendation`:

```ts
export interface Recommendation {
  // existing fields …
  major_volume: number | null;
  minor_volume: number | null;
  peds: number | null;
  vpm: number | null;
  phf: number | null;
  recommended_confidence: number | null;
  hour_start: string | null;  // ISO 8601 UTC
}
```

Old rows can have nulls for these — UI treats nulls as "No data".

### Service — `eyegila/src/services/recommendations.ts`

Add `history(intersectionId, limit=50)`:

```ts
history(intersectionId: number, limit = 50): Promise<RecommendationResponse[]> {
  return request(`/recommendations/history/${intersectionId}?limit=${limit}`);
}
```

Other methods unchanged.

### Page architecture — `eyegila/src/pages/Recommendations.tsx`

The current card-grid layout is replaced. New component tree:

```
RecommendationsPage
 ├─ SummaryStrip            (counts: warranted / borderline / not / no-data)
 ├─ FilterBar               (status chips, name search, W1/W2/W4 chips, min-prob slider)
 ├─ RecommendationsTable    (shadcn Table, sort state local)
 │   └─ TableRow            (status badge, probability cells, num cells, ⋯ regenerate)
 └─ DetailSheet             (shadcn Sheet, opens when row clicked)
     ├─ Tabs (Latest | History)
     ├─ LatestTab
     │   ├─ ProbabilityBars (W1, W2, W4, recommended)
     │   ├─ FeatureGrid     (Major/Minor/Peds/VPM/PHF + hour_start)
     │   ├─ NotesEditor     (Textarea + Save/Cancel)
     │   └─ RegenerateButton
     └─ HistoryTab
         ├─ TrendChart      (recharts LineChart of W1/W2/W4 over generated_at)
         └─ HistoryList     (scrollable list of past runs, each collapsible to its features)
```

#### Table columns

| Column            | Sortable | Format                                                          |
|-------------------|----------|-----------------------------------------------------------------|
| Intersection      | yes      | name (string)                                                   |
| Status            | yes      | badge: Warranted / Borderline / Not warranted / No data         |
| W1                | yes      | probability `0.78` ✓ (✓ shown when `met=true`)                  |
| W2                | yes      | as W1                                                           |
| W4                | yes      | as W1                                                           |
| Major (veh/hr)    | yes      | integer                                                         |
| Peds (per hr)     | yes      | integer                                                         |
| Generated         | yes      | relative ("3 min ago"); absolute on hover                       |
| Actions           | no       | regenerate icon button                                          |

Default sort: Status (Warranted first), then `recommended_confidence` descending.

#### Filter bar

- **Status chips** (multi-select): Warranted / Borderline / Not warranted / No data. All on by default.
- **Name search**: text input, case-insensitive substring match on intersection name.
- **Warrant chips** (multi-select): W1 / W2 / W4. Filters to rows where the chosen warrant has `confidence >= minProb`.
- **Min-prob slider**: 0.00–1.00, default 0.0. Used in conjunction with warrant chips. When no warrant chip is active, the slider is disabled.

All filters are pure-client over the array returned by `list()`. With ≤ a few hundred intersections this is cheap.

#### Status badge derivation (client-side)

```
if hour_start is null OR (major_volume == 0 && minor_volume == 0 && peds == 0)
                                              → "No data"
else if recommended is true                   → "Warranted"
else if any of warrant_*_confidence in [0.3, 0.5)
                                              → "Borderline"
else                                          → "Not warranted"
```

The `hour_start is null` check covers rows written before the migration. The all-zero check covers the empty-data short-circuit.

#### DetailSheet behavior

- Opens via shadcn `Sheet` from the right.
- `Latest` tab uses the row data already in state (no extra fetch).
- `History` tab triggers `recommendationsApi.history(intersectionId)` on first open per drawer-session; result cached in component state.
- Trend chart plots `warrant_1_confidence`, `warrant_2_confidence`, `warrant_4_confidence` across runs (x-axis = `generated_at`, y-axis = 0–1).
- History list rows expand to show that run's Major/Minor/Peds/VPM/PHF and its notes (read-only — only the latest run's notes are editable).
- Regenerate inside drawer → `generate(id)` → response replaces the table's row and prepends to the history list.

### Component reuse

- `shadcn/ui/table` for the table
- `shadcn/ui/sheet` for the drawer
- `shadcn/ui/tabs` for Latest/History
- `shadcn/ui/badge`, `button`, `progress`, `textarea`, `input`, `separator` (already present)
- `recharts` (already present) for the trend chart

No new dependencies.

## Data flow

1. Page mount → parallel `recommendationsApi.list()` + `intersectionsApi.list()`. Merge into a `Map<intersectionId, RecommendationResponse | undefined>` for the table.
2. Sort/filter applied client-side over the array.
3. Row click → set selected intersection ID in component state → Sheet opens.
4. Sheet's Latest tab reads from the already-loaded row.
5. User clicks History tab → `recommendationsApi.history(id)` → cached in component state for the open drawer.
6. Regenerate (drawer or row action) → `recommendationsApi.generate(id)` → response replaces the latest-row in the table state and is prepended to the open drawer's history list (if loaded).
7. Notes save → `recommendationsApi.updateNotes(rec.id, notes)` → response patches the row in table state.

## Error handling

- All network failures surface via the existing `sonner` toast pattern.
- `list()` failure on mount → table area shows "Couldn't load recommendations" with a Retry button; the rest of the page (filter bar) stays visible but disabled.
- `history()` failure → History tab shows inline error + Retry. Latest tab is unaffected.
- `generate()` failure → toast, regenerate button re-enables, no state change.
- `updateNotes()` failure → toast, editor stays open with the user's text intact.

## Testing

### Backend — extend `tests/test_recommendations.py`

- Migration applied: `major_volume, minor_volume, peds, vpm, phf, recommended_confidence, hour_start` exist on `recommendations`; index `ix_recommendations_intersection_generated` exists.
- `generate_recommendation` inserts a new row; prior row for the same intersection still present.
- `generate_all_recommendations` inserts one new row per intersection.
- `GET /recommendations/` returns one row per intersection (the latest), even when history contains multiple per intersection.
- `GET /recommendations/history/{intersection_id}` returns rows in `generated_at DESC` order; respects `limit`; clamps at the max.
- Response payload of all three endpoints contains the seven new fields with correct types.
- Empty-hour case: features all zero, `hour_start` set to the analyzed hour, `notes` is null.
- Existing tests for `PATCH /{rec_id}/notes` still pass.

### Frontend — manual test plan (no test framework in `eyegila/`)

Run `npm run dev` against a backend with several intersections (some with data, some without) and exercise:

- Each sortable column toggles ascending/descending.
- Each status chip toggles inclusion.
- Name search filters in real time.
- Enabling a warrant chip enables the min-prob slider; moving it shrinks the visible rows correctly.
- "No data" intersections render the right badge and have an enabled regenerate button (it inserts a row).
- Row click opens the drawer; default tab is Latest.
- Latest tab shows correct probabilities and features; notes save round-trips correctly.
- History tab fetches and renders the chart; multiple regenerations within the drawer extend the chart.
- Regenerate inside drawer updates both the drawer (chart + history list) and the table row.
- Closing the drawer and reopening for a different intersection re-fetches history (cache is per-open-drawer).

## File layout summary

```
alembic/versions/0004_recommendations_metrics_and_history.py   # new
common/models.py                                                # Recommendation extended
server/routers/recommendations.py                               # rewritten (insert-not-replace, history endpoint, structured fields)
tests/test_recommendations.py                                   # extended

eyegila/src/types/index.ts                                      # Recommendation extended
eyegila/src/services/recommendations.ts                         # +history()
eyegila/src/pages/Recommendations.tsx                           # rewritten (table + drawer + tabs)
eyegila/src/components/recommendations/                         # new dir
  ├── SummaryStrip.tsx
  ├── FilterBar.tsx
  ├── RecommendationsTable.tsx
  ├── DetailSheet.tsx
  ├── LatestTab.tsx
  ├── HistoryTab.tsx
  └── statusBucket.ts                                           # bucketing helper, shared
```

`RecommendationsPage` itself stays slim — it owns fetched state and renders children.

## Open questions

None — all decisions captured above.
