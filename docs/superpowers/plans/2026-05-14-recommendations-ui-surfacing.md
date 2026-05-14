# Recommendations UI Surfacing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface the warrant-model output beyond the Recommendations page — add status badges to the Intersections list and Dashboard intersection cards, hydrate the existing placeholder warrant card on the Dashboard's focused-intersection panel. Add diagnostic logs to make it easier to see "where things go wrong."

**Architecture:**
- Reuse the existing `statusBucket` / `BUCKET_LABEL` / `BUCKET_BADGE_CLASS` helpers from `components/recommendations/statusBucket.ts` — no new helper.
- Both pages fetch `recommendationsApi.list()` once on mount, map by `intersection_id`, render badge per intersection.
- Dashboard's placeholder warrant card (lines 781-808) hydrates from the same map for `selectedInter`.
- Backend logging via Python's `logging` module wired through FastAPI's existing logger setup; frontend logging via `console.log` / `console.error` gated behind a `DEBUG_RECOMMENDATIONS` flag from `import.meta.env` so they're easy to silence in production.

**Tech Stack:** existing — React/Vite, FastAPI, no new deps.

---

## Task A: Intersections list — warrant badge column

**Files:**
- Modify: `eyegila/src/pages/Intersections.tsx`

- [ ] **Step 1: Read the current shape**

Locate the list-row render (around lines 163-214). Identify a stable place to insert the badge — typically next to the street count or in the right-side actions column.

- [ ] **Step 2: Add recommendations fetch and badge render**

```tsx
// Imports (add)
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from '@/components/recommendations/statusBucket';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Inside the page component, near the existing useState/useEffect for intersections:
const [recsById, setRecsById] = useState<Map<number, RecommendationResponse>>(new Map());

useEffect(() => {
  let cancelled = false;
  recommendationsApi.list()
    .then(recs => {
      if (cancelled) return;
      setRecsById(new Map(recs.map(r => [r.intersection_id, r])));
    })
    .catch(() => { /* silent — page works without recs */ });
  return () => { cancelled = true; };
}, []);
```

Inside each row's JSX, after the existing street count or in the action column, render:

```tsx
{(() => {
  const rec = recsById.get(intersection.id);
  if (!rec) return null;
  const b = statusBucket(rec);
  return (
    <Badge variant="outline" className={cn('text-[10px]', BUCKET_BADGE_CLASS[b])}>
      {BUCKET_LABEL[b]}
    </Badge>
  );
})()}
```

- [ ] **Step 3: Type-check**

Run: `cd eyegila && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit`

- [ ] **Step 4: Commit**

```bash
git add eyegila/src/pages/Intersections.tsx
git commit -m "feat(fe): show warrant status badge on Intersections list"
```

---

## Task B: Dashboard intersection cards — warrant badge

**Files:**
- Modify: `eyegila/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add recommendations fetch + render**

Around the existing card map (lines ~541-661), find where each intersection card is rendered. Add the same `recsById` state pattern as Task A. Place a small badge in the card's top-right corner (next to or below the existing density badge).

Imports:
```tsx
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from '@/components/recommendations/statusBucket';
```

State:
```tsx
const [recsById, setRecsById] = useState<Map<number, RecommendationResponse>>(new Map());

useEffect(() => {
  let cancelled = false;
  recommendationsApi.list()
    .then(recs => {
      if (cancelled) return;
      setRecsById(new Map(recs.map(r => [r.intersection_id, r])));
    })
    .catch(() => { /* silent */ });
  return () => { cancelled = true; };
}, []);
```

Inside the card render, where the density badge is:

```tsx
{(() => {
  const rec = recsById.get(inter.id);
  if (!rec) return null;
  const b = statusBucket(rec);
  return (
    <Badge variant="outline" className={cn('text-[10px]', BUCKET_BADGE_CLASS[b])}>
      {BUCKET_LABEL[b]}
    </Badge>
  );
})()}
```

If the existing density badge has its own wrapper, reuse the wrapper; otherwise add a flex container that holds both.

- [ ] **Step 2: Type-check**

`cd eyegila && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit`

- [ ] **Step 3: Commit**

```bash
git add eyegila/src/pages/Dashboard.tsx
git commit -m "feat(fe): show warrant status badge on Dashboard intersection cards"
```

---

## Task C: Dashboard warrant card — hydrate placeholder

**Files:**
- Modify: `eyegila/src/pages/Dashboard.tsx` (around lines 781-808)

- [ ] **Step 1: Replace the placeholder rows with hydrated content**

Replace the `(['W1 - 8-Hour Volume', 'W2 - 4-Hour Volume', 'W4 - Pedestrian Volume'] as const).map(...)` block with:

```tsx
{(() => {
  const rec = selectedInter ? recsById.get(selectedInter.id) : undefined;
  const rows = [
    { label: 'W1 — 8-Hour Volume',       met: rec?.warrant_1_met, conf: rec?.warrant_1_confidence },
    { label: 'W2 — 4-Hour Volume',       met: rec?.warrant_2_met, conf: rec?.warrant_2_confidence },
    { label: 'W4 — Pedestrian Volume',   met: rec?.warrant_4_met, conf: rec?.warrant_4_confidence },
  ];
  return rows.map(r => (
    <div key={r.label} className="flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground">{r.label}</span>
      {rec ? (
        <Badge
          variant="outline"
          className={cn(
            'text-[10px]',
            r.met
              ? 'border-emerald-500/40 text-emerald-700 bg-emerald-50'
              : 'border-slate-200 text-slate-500',
          )}
        >
          {r.met ? '✓' : '·'} {((r.conf ?? 0) * 100).toFixed(0)}%
        </Badge>
      ) : (
        <Badge variant="outline" className="text-[10px] border-slate-200 text-slate-400">—</Badge>
      )}
    </div>
  ));
})()}
```

- [ ] **Step 2: Update the link text based on rec presence**

Replace the `<Link to="/recommendations">…Run warrant analysis…</Link>` with a conditional:

```tsx
<Link to="/recommendations" className="text-[11px] text-primary hover:underline inline-flex items-center gap-1">
  {selectedInter && recsById.get(selectedInter.id) ? 'View details' : 'Run warrant analysis'}
  <ExternalLink className="size-2.5" aria-hidden="true" />
</Link>
```

- [ ] **Step 3: Type-check**

`cd eyegila && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit`

- [ ] **Step 4: Commit**

```bash
git add eyegila/src/pages/Dashboard.tsx
git commit -m "feat(fe): hydrate Dashboard warrant card with latest recommendation"
```

---

## Task D: Diagnostic logging — backend

**Files:**
- Modify: `server/routers/recommendations.py`

- [ ] **Step 1: Add module-level logger**

At the top of `server/routers/recommendations.py` (after the imports):

```python
import logging
import time

log = logging.getLogger("recommendations")
```

- [ ] **Step 2: Log every analysis run**

Inside `_analyze`, after computing features and before returning:

```python
def _analyze(intersection_id, artifacts, db):
    from server.ml.inference import predict_warrants
    t0 = time.perf_counter()
    features, hour_start = _compute_features(intersection_id, db)
    elapsed_feat = (time.perf_counter() - t0) * 1000

    if features["major_volume"] == 0 and features["minor_volume"] == 0 and features["peds"] == 0:
        log.info(
            "analyze intersection=%d hour=%s EMPTY_DATA (feat_ms=%.1f)",
            intersection_id, hour_start.isoformat(), elapsed_feat,
        )
        return { ... }  # existing zero return

    t1 = time.perf_counter()
    probs = predict_warrants(artifacts, features)
    elapsed_pred = (time.perf_counter() - t1) * 1000

    log.info(
        "analyze intersection=%d hour=%s "
        "feat=(maj=%d min=%d ped=%d vpm=%d phf=%.2f) "
        "prob=(w1=%.2f w2=%.2f w4=%.2f rec=%.2f) "
        "(feat_ms=%.1f pred_ms=%.1f)",
        intersection_id, hour_start.isoformat(),
        features["major_volume"], features["minor_volume"], features["peds"],
        features["vpm"], features["phf"],
        probs["w1"], probs["w2"], probs["w4"], probs["recommended"],
        elapsed_feat, elapsed_pred,
    )

    return { ... }  # existing model return
```

- [ ] **Step 3: Log history requests**

In `list_history`, add:

```python
log.info("history intersection=%d limit=%d → %d rows", intersection_id, limit, len(rows))
```

after the `.all()` call, before the return.

- [ ] **Step 4: Rebuild + restart server**

```bash
docker compose -f docker-compose.mac.yml build server
docker compose -f docker-compose.mac.yml up -d server
```

- [ ] **Step 5: Verify in logs**

Trigger one generate from the UI or via curl, then:

```bash
docker compose -f docker-compose.mac.yml logs server --tail 30 | grep recommendations
```

Expected: one INFO line per analysis.

- [ ] **Step 6: Commit**

```bash
git add server/routers/recommendations.py
git commit -m "feat: structured logging in recommendations endpoints"
```

---

## Task E: Diagnostic logging — frontend

**Files:**
- Modify: `eyegila/src/pages/Recommendations.tsx`

- [ ] **Step 1: Add a debug flag + log helper**

At the top of `Recommendations.tsx`:

```tsx
const DEBUG = import.meta.env.DEV || import.meta.env.VITE_DEBUG_RECOMMENDATIONS === '1';
function dlog(...args: unknown[]) { if (DEBUG) console.log('[recommendations]', ...args); }
function derr(...args: unknown[]) { console.error('[recommendations]', ...args); }
```

`derr` always logs (errors are useful in prod); `dlog` only in dev or when the env var is set.

- [ ] **Step 2: Sprinkle logs in the page's action functions**

In `load`:
```tsx
dlog('load: fetching intersections + recommendations');
const t0 = performance.now();
// existing Promise.all
dlog(`load: done in ${(performance.now() - t0).toFixed(0)}ms — ${ints.length} intersections, ${r.length} recs`);
// in catch:
derr('load failed', err);
```

In `regenerateOne`:
```tsx
dlog(`regenerateOne: intersection=${intersectionId}`);
const t0 = performance.now();
// before return fresh:
dlog(`regenerateOne: done in ${(performance.now() - t0).toFixed(0)}ms`, fresh);
// in catch:
derr(`regenerateOne intersection=${intersectionId} failed`, err);
```

In `regenerateAll`:
```tsx
dlog('regenerateAll: starting');
const t0 = performance.now();
// after success:
dlog(`regenerateAll: done in ${(performance.now() - t0).toFixed(0)}ms — ${results.length} recs`);
// in catch:
derr('regenerateAll failed', err);
```

- [ ] **Step 3: Type-check + build**

```bash
cd eyegila && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit
./node_modules/.bin/vite build
```

- [ ] **Step 4: Commit**

```bash
git add eyegila/src/pages/Recommendations.tsx
git commit -m "feat(fe): diagnostic logging in Recommendations page actions"
```

---

## Manual verification (after all tasks)

- Reload the Intersections page → each row shows a status badge (or none if intersection has no rec yet).
- Reload the Dashboard → each intersection card shows a status badge.
- Focus an intersection on the Dashboard → the right-column warrant card shows real met/unmet badges with confidence %, and the link says "View details" instead of "Run warrant analysis".
- Click Regenerate on the Recommendations page → check `docker compose logs server --tail 20` shows the new `analyze ... prob=(...)` INFO lines.
- Open browser DevTools console on the Recommendations page → see `[recommendations]` log entries during load/regenerate.
