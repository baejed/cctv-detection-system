# Signal Timing & Simulation — Implementation Issues

Generated from client brief session. 7 vertical slices, each cuts through schema → API → UI → tests.

---

## Issue 1: Add intersection signal status and existing timing baseline

**Type:** AFK
**Blocked by:** None — can start immediately

### What to build

Add the foundational data model for tracking each intersection's current signal state and its existing timing configuration. This is the baseline the simulation uses for before/after comparison.

A new `signal_status` enum column (`unsignalized`, `fixed_time`, `actuated`) is added to the intersections table. Two additional fields store the existing timing: `existing_cycle_length` (seconds) and per-approach `existing_green_splits` (seconds per approach, keyed by street/direction). When `existing_green_splits` is not provided, the system defaults to an equal-split across all 4 approaches.

The intersection detail UI gains a form where a traffic engineer can set the signal status and enter the known timing. Equal-split is shown as the pre-filled default.

### Acceptance criteria

- [ ] `signal_status` enum column exists on intersections table with values `unsignalized`, `fixed_time`, `actuated`
- [ ] `existing_cycle_length` (integer, nullable) column exists on intersections table
- [ ] Per-approach `existing_green_splits` stored and retrievable (JSON or child table)
- [ ] API endpoint accepts PATCH to update signal status and existing timing for an intersection
- [ ] UI form on intersection detail allows setting all three fields
- [ ] When `existing_green_splits` is empty, API returns equal-split default (cycle ÷ 4 per approach)
- [ ] Alembic migration included
- [ ] Integration test covers round-trip: PATCH timing → GET intersection → verify fields

---

## Issue 2: PCE configuration layer with DPWH defaults and auto-calibration

**Type:** AFK
**Blocked by:** None — can start immediately

### What to build

Implement the three-tier PCE (Passenger Car Equivalent) system used to convert raw vehicle counts into PCUs for Webster's formula.

**Tier 1 — DPWH defaults:** hardcoded baseline values per vehicle type (motorcycle ≈ 0.33, pedicab/tricycle ≈ 1.5, car = 1.0, bus ≈ 2.5, truck ≈ 2.5, bicycle ≈ 0.5).

**Tier 2 — Auto-calibration:** a background job (or on-demand computation) that reads the observed vehicle mix from `aggregation_summaries` over a rolling 7-day window and adjusts PCE weights proportionally to the actual fleet composition at each intersection.

**Tier 3 — Admin override:** a per-intersection PCE config table where an engineer can set explicit values that take precedence over both tiers above.

The API resolves PCE values at query time using the highest-priority tier available. The UI shows the resolved PCE values on the intersection settings page with a label indicating which tier is active (default / calibrated / overridden).

### Acceptance criteria

- [ ] DPWH PCE defaults defined and used as fallback for all intersections
- [ ] Per-intersection PCE override table with CRUD API endpoints
- [ ] Auto-calibration computation reads 7-day `aggregation_summaries` vehicle mix and stores calibrated values
- [ ] API resolves PCE in priority order: override → calibrated → DPWH default
- [ ] UI on intersection settings shows resolved PCE per vehicle type with active tier label
- [ ] Calibrated values update without a code deploy (stored in DB)
- [ ] Unit tests for PCE resolution priority logic
- [ ] Integration test: override a PCE value, confirm it takes precedence over calibrated

---

## Issue 3: Time-of-day plan configuration per intersection

**Type:** AFK
**Blocked by:** None — can start immediately

### What to build

Add time-of-day (TOD) chunk definitions so recommendations and timing suggestions can vary by period. The system ships with 5 standard periods as the default for every intersection:

| Chunk | Window |
|---|---|
| Early Morning | 12:00 AM – 6:00 AM |
| AM Peak | 6:00 AM – 9:00 AM |
| Midday | 9:00 AM – 12:00 PM |
| PM Peak | 12:00 PM – 6:00 PM |
| Night | 6:00 PM – 12:00 AM |

These are stored per intersection so an engineer can adjust boundaries (e.g., shift AM Peak to 7–9 AM for a school-zone intersection). The API returns the active chunk for any given timestamp, which downstream services use when generating per-chunk recommendations.

### Acceptance criteria

- [ ] TOD chunks table with `intersection_id`, `name`, `start_time`, `end_time` columns
- [ ] 5 standard chunks seeded automatically for every intersection (migration or seed script)
- [ ] API endpoint to list/update chunks per intersection
- [ ] API utility returns the active chunk name for a given intersection + timestamp
- [ ] UI on intersection settings shows chunk boundaries with inline edit
- [ ] Validation: chunks must be non-overlapping and cover all 24 hours
- [ ] Integration test: update a chunk boundary, confirm active-chunk lookup returns correct name

---

## Issue 4: Webster's formula engine and per-chunk timing recommendations

**Type:** AFK
**Blocked by:** Issues 1, 2, 3

### What to build

Implement the core signal timing engine using Webster's formula for 4-phase intersections. This generates a cycle length and green duration per approach for each time-of-day chunk, plus one overall daily summary. Results are stored and surfaced alongside warrant recommendations.

**Webster's formula inputs (per chunk):**
- Per-approach PCU flow: sum of vehicle counts from `aggregation_summaries` for the chunk window, converted to PCUs using the resolved PCE values from Issue 2
- Lost time per phase: 4 seconds (DPWH default, configurable per intersection)
- All-red clearance: 3 seconds between phases (DPWH default, configurable)
- Cycle length bounds: min 40s, max 120s (DPWH default, configurable per intersection)

**Outputs stored in a new `timing_recommendations` table:**
- One row per intersection × time chunk × generation run
- Fields: `cycle_length`, `green_splits` (JSON, seconds per approach), `effective_date`, `chunk_name`, `pce_tier_used`
- One additional row with `chunk_name = 'overall'` summarizing the peak-hour timing

Timing recommendation generation runs automatically whenever a warrant recommendation is generated (same trigger, same transaction boundary). The existing Recommendations page gains a one-line timing summary per intersection: "Suggested cycle: 90s (PM Peak)".

### Acceptance criteria

- [ ] Webster's formula correctly computes cycle length and green splits for a 4-phase intersection given PCU flows and lost time
- [ ] Cycle length clamped to configurable min/max (default 40s–120s)
- [ ] `timing_recommendations` table created with correct schema and migration
- [ ] Timing generation triggered automatically on `POST /recommendations/generate/{id}` and `generate-all`
- [ ] Per-chunk rows + one `overall` row inserted per generation run
- [ ] `GET /timing-recommendations/{intersection_id}` endpoint returns latest per-chunk results
- [ ] Recommendations page shows timing summary line per intersection
- [ ] Unit tests for Webster's formula (verify cycle length, green splits, clamping)
- [ ] Integration test: generate recommendation → verify timing rows inserted with correct chunk breakdown

---

## Issue 5: Local warrant layer (W-Local 1, 2, 3) for Tagum City conditions

**Type:** AFK
**Blocked by:** Issues 3, 4

### What to build

Add three Tagum-specific warrants that run alongside the existing MUTCD W1/W2/W4 model. These capture conditions that MUTCD's car-centric thresholds miss for a pedicab/motorcycle-dominant city.

**W-Local 1 — High motorcycle/pedicab ratio:** triggered when motorcycles + pedicabs exceed a configurable threshold (default 60%) of total vehicle volume in any time chunk. Signals higher conflict risk than MUTCD volume thresholds would indicate.

**W-Local 2 — Peak concentration:** triggered when ≥70% of daily volume is concentrated in 1–2 time chunks, indicating that a fixed all-day signal configuration would cause congestion during off-peak periods.

**W-Local 3 — Lights off:** triggered when PCU volume in a time chunk falls below a configurable minimum (default 30 PCU/hr per approach). The suggested configuration for that chunk is `signal_off` / flashing yellow rather than a timed cycle.

Local warrant thresholds are configurable per intersection via the admin settings. The warrant generation pipeline evaluates all three and includes them in the `Recommendation` response. The Recommendations page shows W-Local 1/2/3 pills alongside the existing W1/W2/W4 pills.

### Acceptance criteria

- [ ] W-Local 1 evaluated and stored per recommendation run (met/not met + confidence)
- [ ] W-Local 2 evaluated and stored per recommendation run
- [ ] W-Local 3 evaluated per time chunk; chunk marked `signal_off` when triggered
- [ ] Thresholds configurable per intersection with DPWH/sensible defaults
- [ ] `Recommendation` API response includes local warrant fields
- [ ] Recommendations page renders W-Local 1/2/3 pills with met/not-met state
- [ ] Unit tests for each local warrant evaluation function
- [ ] Integration test: intersection with >60% motorcycle volume → W-Local 1 fires

---

## Issue 6: Analytical delay simulation, numerical output, and Signal Timing page

**Type:** AFK
**Blocked by:** Issue 4

### What to build

Implement the before/after delay simulation and create the dedicated Signal Timing page that shows results per time chunk.

**Delay computation:**
- *Signalized (proposed):* Webster's uniform delay formula — `d = (C(1-g/C)²) / (2(1-q·C/3600))` per approach, summed across all approaches weighted by flow
- *Before-state baseline:*
  - `fixed_time` intersections: same formula using `existing_cycle_length` and `existing_green_splits` (equal-split default if not entered)
  - `unsignalized` intersections: HCM gap-acceptance average delay for minor-street approaches

**Outputs per time chunk:**
- Average delay per vehicle (seconds): before and after
- Total vehicle-hours saved per day: `(delay_before - delay_after) × daily_volume / 3600`, summed across chunks

Results stored in a `simulation_results` table linked to the `timing_recommendations` row.

**Signal Timing page (`/timing/{intersection_id}`):**
- Per-chunk table: chunk name, proposed cycle, avg delay before, avg delay after, vehicle-hours saved
- Daily summary row at bottom
- Time-series chart: queue length (vehicles) per approach over a simulated hour, one line per approach, before/after toggle

### Acceptance criteria

- [ ] Webster's uniform delay computed correctly for signalized before/after
- [ ] HCM gap-acceptance delay computed for unsignalized baseline
- [ ] `simulation_results` table stores per-chunk delay metrics
- [ ] `GET /simulation/{intersection_id}` returns per-chunk and daily summary
- [ ] Signal Timing page renders per-chunk table with before/after delay columns
- [ ] Vehicle-hours saved shown in daily summary row
- [ ] Time-series chart renders queue length over simulated hour with before/after toggle
- [ ] Unit tests for delay formulas (uniform delay, gap-acceptance)
- [ ] Integration test: generate timing → fetch simulation → verify delay reduction for a signalized intersection

---

## Issue 7: Top-down 2D canvas simulation on Signal Timing page

**Type:** AFK
**Blocked by:** Issue 6

### What to build

Add an interactive top-down canvas to the Signal Timing page that animates the intersection under both the current (before) and proposed (after) timing plans. This makes the delay improvement tangible for traffic engineers and LGU decision-makers.

The canvas renders a simple 4-leg intersection diagram with 4 approach arms. Each approach arm shows a queue bar that grows as vehicles arrive during a red phase and shrinks as they discharge during green. The signal phase cycles visually (one approach green at a time, 4-phase rotation). A play/pause control and a speed multiplier (1×, 5×, 10×) let the user watch the full simulated hour quickly.

A **Before / After toggle** switches between the current timing baseline and the proposed Webster's timing, using the same arrival rates from the simulation data. Side-by-side mode (optional enhancement) shows both simultaneously.

The canvas is built in React using the HTML Canvas API — no external simulator dependency.

### Acceptance criteria

- [ ] Canvas renders a top-down 4-leg intersection with labeled approach arms
- [ ] Queue bar per approach grows during red phase and clears during green phase
- [ ] Signal phase cycles correctly (4-phase, matching proposed cycle and green splits)
- [ ] Play/pause and speed controls (1×, 5×, 10×) work correctly
- [ ] Before/After toggle switches between current and proposed timing
- [ ] Animation uses arrival rates derived from the simulation data (Issue 6), not hardcoded
- [ ] Canvas is responsive (fits mobile and desktop viewports)
- [ ] No external simulator dependency (HTML Canvas API only)

---

## Execution order

```
Issues 1, 2, 3  ──► Issue 4  ──► Issues 5, 6  ──► Issue 7
(parallel)                        (parallel)
```
