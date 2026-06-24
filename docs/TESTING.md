# EyeGila Testing Guide

## MacBook Setup

**Prerequisites:** Docker Desktop for Mac, `make`, Python 3.12, Node.js 18+

```bash
# 1. Copy environment config
cp .env.example .env
# Open .env and set SUPER_KEY to any string (e.g. "devkey123")

# 2. Start the full stack - CPU only, no GPU required
make dev-mac

# 3. Wait ~30s for the DB to initialise, then seed test data
docker compose logs server -f   # wait for "Application startup complete"
python3 scripts/fake_detections.py --seed

# 4. Open the UI
open http://localhost:5173
```

The model file (`eyegila_v4.pt`) sits in the project root and is volume-mounted
into the worker at `/app/model.pt` automatically - no image rebuild needed when
you swap model versions.

To stop the stack:

```bash
make dev-mac-down
```

---

## Test Layers at a Glance

| Layer | Command | Needs stack? | Time |
|-------|---------|-------------|------|
| Unit | `make test-unit` | No | ~5s |
| Functionality | `make test-functionality` | Yes | ~10s |
| Integration | `make test-integration` | Yes | ~60s |
| All Python | `make test` | Yes | ~90s |
| Frontend unit | `make test-frontend` | No | ~3s |
| E2E (Playwright) | `make test-e2e` | Yes + Vite dev server | ~60s |

---

## Unit Tests

No server needed. Run anytime, even without Docker.

```bash
make test-unit
# or directly:
python3 -m pytest tests/test_stress.py tests/test_pedestrian_timing.py \
    tests/test_cycle_detection.py -q
```

**What is covered:**

- Webster's formula: cycle length clamping, green split proportionality,
  pedestrian minimum, 100-intersection randomised fuzz
- Simulation math: uniform delay, HCM gap delay, v/c ratio, queue series,
  LOS grade thresholds
- PCE calibration: DPWH defaults, scale clamping, empty observation edge case
- Local warrants: W1/W2/W3 boundary conditions, confidence values
- Cycle detection: Pearson r, Poisson dispersion, synthetic signal patterns
- Warrant model: feature extraction (PHF, vpm, major/minor split), inference
  probabilities in [0, 1], monotonicity, W4 pedestrian trigger

---

## Functionality Tests

End-to-end user flows - each test simulates a complete operator journey
from start to finish. Requires `make dev-mac` to be running.

```bash
make test-functionality
# or with verbose output:
python3 -m pytest tests/test_functionality.py -v
```

| ID | Flow | What it verifies |
|----|------|-----------------|
| FT-01 | New intersection setup → timing | 4-arm setup, Webster runs, 6 timing rows [40–120 s], simulation created |
| FT-02 | Camera lifecycle | Create → list → rename → status is offline when no worker |
| FT-03 | Recommendation history | 3 generations → history grows newest-first → list shows only latest |
| FT-04 | Manual signal timing | PATCH fixed-time plan persists on GET |
| FT-05 | Warrant model end-to-end | Feature extraction → inference → probabilities in [0,1]; busy intersection recommended |
| FT-06 | CSV bulk import | 1 intersection + 2 cameras, re-import produces no duplicates |
| FT-07 | Auth login/logout | Login → use → logout → token revoked |
`| FT-08 | Simulation delay ordering | `delay_after <= delay_before` (signal helps or is neutral), LOS grades valid (A–F), `total_vehicle_hours_saved` is finite |

---

## Integration Tests

Tests every individual API endpoint. Requires `make dev-mac` and seed data.

```bash
make test-integration
```

Covers: auth (login, logout, rate limit), intersection CRUD, street CRUD,
camera CRUD, CSV import, signal timing PATCH, aggregation, TOD chunks,
recommendation generation (single + all), recommendation history,
timing rows, simulation rows, worker claim/heartbeat.

---

## E2E Tests (Playwright)

Browser-level tests that drive the real UI. Require the full stack
**plus** the Vite dev server.

### Setup (one-time)

```bash
cd eyegila
npx playwright install chromium
```

### Running

```bash
# Full stack first:
make dev-mac

# Then in a second terminal - start the Vite dev server:
cd eyegila && npm run dev

# Then run Playwright:
make test-e2e
# or directly (the config lives under e2e/, so the flag is required):
cd eyegila && npx playwright test --config e2e/playwright.config.ts

# Watch the browser in headed mode:
cd eyegila && npx playwright test --config e2e/playwright.config.ts --headed

# Playwright interactive UI (best for debugging):
cd eyegila && npx playwright test --config e2e/playwright.config.ts --ui
```

### What Playwright covers

| Spec | Tests |
|------|-------|
| `app.spec.ts` - Login | Fields render, wrong password stays on /login, valid creds redirect, unauthenticated nav redirects |
| `app.spec.ts` - Intersections list | At least one intersection after seed, page title correct |
| `app.spec.ts` - Recommendations | No JS errors, W1/W2/W4 badges visible |
| `app.spec.ts` - Signal Timing | No JS errors, LOS badges visible, 3D canvas rendered, timing controls visible, cycle lengths in 40–120 s range |
| `app.spec.ts` - Camera Detail | Camera list loads without errors |
| `app.spec.ts` - Navigation | Nav links lead to correct routes, 404 shows fallback (not blank) |
| `app.spec.ts` - Responsive | Recommendations page no horizontal overflow on 375×667 mobile |
| `auth-expiry.spec.ts` | Server-revoked token collapses 401 storm to ≤1 toast + one redirect; login after expiry restores access without bouncing back to /login |
| `wizard-happy-path.spec.ts` | Full onboarding wizard: Discover → Name → Assign → Create → Done |
| `intersection-delete.spec.ts` | Delete intersection from the settings sheet removes the card |
| `timing-no-data.spec.ts` | Every approach gets non-zero green time even with no detections |
| `probe.spec.ts` | Diagnostic probe - confirms login storage state is healthy |

### Tips

- Use `--ui` mode when writing new tests - it shows a live browser + step tree
- Use `page.on('pageerror', ...)` to catch JS crashes without waiting for assertions
- Screenshots on failure are saved to `eyegila/test-results/`
- Set `PLAYWRIGHT_OUTPUT_DIR` env var to redirect output
- Use `test.skip()` inside a test body to skip conditionally
  (e.g., when seed data is missing)

---

## QA Scenarios (Manual)

Run before any release. These cover cases automated tests can't fully verify.

### Data pipeline

- Seed detections (`python3 scripts/fake_detections.py --seed`), then open
  Recommendations and confirm warrant results are not all zeros
- POST `/recommendations/generate-all` via the UI and verify `timing_cycle`
  is between 40–120 for each intersection

### Signal timing page

- Set a date range that spans midnight (e.g., 23:00 today → 00:30 tomorrow)
  and confirm the bar chart loads without a blank panel or console error
- Verify all 5 TOD chunk labels appear: AM, Midday, PM, Evening, Overnight

### Live camera stream *(requires a real or simulated RTSP source)*

- Add a camera with a valid RTSP URL; wait 30 s; confirm status changes
  `offline` → `online`
- Open the camera detail page and confirm the live feed renders
- Kill the RTSP source; wait 60 s; confirm status drops back to `offline`
- Restart the source; confirm the worker reconnects automatically (no manual intervention)

### Auth edge cases

- Log in on two browser tabs, log out in one, refresh the other -
  it must redirect to login within one page refresh
- Hit `/intersections/` with a fake token and confirm 401 response
- Leave a session idle for longer than `SESSION_TTL_HOURS` (default 24 h)
  and confirm the next request returns 401

### CSV import

- Upload the sample CSV from `docs/superpowers`, confirm intersection and cameras appear
- Upload a malformed CSV (remove the `rtsp_url` column), confirm 400 with a readable message
- Upload a CSV with 100 rows and confirm all rows import within 10 s

---

## Usability Testing

Sessions run with a real Tagum City traffic operator. The tester uses the
system without guidance while you observe and take notes.

**Setup:** `make dev-mac` + seeded data. Do not help - observe where they pause.

### Tasks

Give each task verbally. Say nothing else.

**Task 1 - Register a new intersection and camera**
> "You've been given access to the system. Add a new intersection at Tagum
> City Hall and assign a camera to it."

- Pass: Created intersection + camera in under 3 minutes without help
- Fail: Could not find the Add button, confused by the RTSP URL field

**Task 2 - Confirm a camera is receiving a signal**
> "A new camera was installed at the intersection. Register it and confirm
> it is receiving a signal."

- Pass: Adds camera, waits, sees status become online
- Fail: Doesn't know what "offline" means, doesn't know to wait

**Task 3 - Enter the existing fixed-time plan**
> "The traffic engineer says the current cycle is 90 seconds. Enter that
> into the system."

- Pass: Finds Signal Timing page, enters fixed-time plan
- Fail: Enters data in the wrong field, or cannot find the page

**Task 4 - Check whether this intersection needs a signal**
> "Ask the system whether this intersection needs a traffic signal."

- Pass: Finds Recommendations page, reads the warrant result
- Fail: Doesn't understand W1/W2/W4 labels, no explanation visible

**Task 5 - Share the timing plan with the council**
> "Print or export the timing recommendation for the council meeting."

- Pass: Uses Present mode or the export button successfully
- Fail: No visible export path found

### What to measure

- Time on task (target: each task under 3 minutes)
- Error count (wrong clicks, dead ends)
- Verbal confusion count ("where is…?", "what does this mean?")
- Whether the user reads or skips the status/LOS labels

---

## Alpha Testing

Run by the development team before showing the system to any real user.
Goal: find integration bugs and data issues in a production-like environment.

**Environment:** Full GPU stack (`docker compose up -d`), real RTSP cameras if available.

### Checklist

- [ ] Cold start from empty DB: run migrations, seed, open UI - no 500 errors
- [ ] `make test` passes 100% (unit + integration + functionality)
- [ ] Generate recommendations for all seeded intersections - no null `timing_cycle`
- [ ] Signal Timing page: bar chart loads for all 5 TOD chunks, no blank panels
- [ ] 3D intersection view renders without WebGL error in Chrome and Safari
- [ ] Camera with active RTSP stream: live feed appears within 60 s of adding
- [ ] Worker restart: `docker compose restart worker` → camera re-claims within 30 s
- [ ] Auth: rate-limit kicks in at 11 rapid login attempts (`pytest -m ratelimit`)
- [ ] All timestamps in UI are in Manila time (UTC+8), not UTC
- [ ] Simulation page: delay before/after chart renders for all TOD chunks
- [ ] Manual page PDF render: no tables are truncated
- [ ] Midnight date-range on Signal Timing page: chart loads correctly
- [ ] `ANALYSIS_INTERVAL_MINUTES=60` set → background job runs on schedule, no crash

**Pass criteria:** All items checked, zero P0 bugs (crash, data loss, auth bypass).

---

## Beta Testing

Run by a small group of real operators (Tagum City traffic staff) for 1–2 weeks
in a staging environment with real cameras.

**Scope:** Core flows only - camera enrollment, daily recommendation generation,
signal timing review. No destructive operations (no DELETE for real intersections).

### What to give beta testers

- Staging URL and login credentials
- A 1-page quick-start card: how to add a camera, run a recommendation,
  export the timing plan
- A feedback form (Google Form or Linear issue board link)
- Your WhatsApp number for urgent bugs

### Metrics to collect

| Metric | Target |
|--------|--------|
| Recommendation generated daily without error | 100% |
| Operators can add a camera without support call | ≥ 80% |
| UI loads in < 3 s on local network | ≥ 95% of page loads |
| No data loss after worker restart | 100% |
| At least one operator exports timing plan to council | Required before ship |

### Exit criteria (ready to ship to production)

- Zero P0 bugs open (crash, data loss, auth bypass)
- No more than 2 P1 bugs open (wrong calculation, key feature broken)
- At least 3 operators have completed the recommendation flow independently
- All Alpha checklist items re-verified on the staging environment
