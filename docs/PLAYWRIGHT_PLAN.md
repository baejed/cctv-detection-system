# EyeGila Playwright E2E Test Plan

## What Playwright Is For

Playwright drives a real browser against the live UI. It catches things no
unit or API test can: broken rendering, missing text, flows that require
multiple pages, JS errors at runtime, and regressions introduced by UI
changes. It is the closest thing to a real user sitting at the screen.

The existing unit and integration tests verify the backend math and API
contracts. Playwright verifies the frontend - does the page load, can the
user actually do the thing, does anything crash?

---

## Pre-requisites to Run

```
docker compose up -d                  # backend stack
python3 scripts/fake_detections.py --seed   # seed data
cd eyegila && npm run dev             # Vite dev server on :5173
cd eyegila && npx playwright install chromium  # one-time browser install
```

Run:

```
cd eyegila && npx playwright test             # headless (CI)
cd eyegila && npx playwright test --headed    # watch the browser
cd eyegila && npx playwright test --ui        # interactive step-through
```

Current config: `eyegila/e2e/playwright.config.ts`
Current spec:   `eyegila/e2e/app.spec.ts`

---

## Step 1 - Add data-testid Attributes

None of the pages have `data-testid` attributes yet. Without them, selectors
rely on text content and ARIA roles, which break whenever copy changes. Before
writing tests, add a `data-testid` to every interactive element that a test
will touch.

### Priority list - what to add first

| Page / Component | Element | Suggested `data-testid` |
|-----------------|---------|------------------------|
| Login | Username input | `input-username` |
| Login | Password input | `input-password` |
| Login | Sign in button | `btn-sign-in` |
| Login | Error alert | `alert-login-error` |
| Intersections | Add intersection button | `btn-add-intersection` |
| Intersections | Each intersection card | `intersection-card-{id}` |
| Intersections | Grid / Map toggle | `toggle-view-grid`, `toggle-view-map` |
| Intersection Setup Wizard | Next button | `btn-wizard-next` |
| Intersection Setup Wizard | Back button | `btn-wizard-back` |
| Intersection Setup Wizard | Intersection name input | `input-intersection-name` |
| Intersection Setup Wizard | Camera RTSP input | `input-rtsp-url` |
| Cameras | Each camera row | `camera-row-{id}` |
| Camera Detail | Status badge | `badge-camera-status` |
| Camera Detail | Live feed container | `feed-container` |
| Recommendations | Generate All button | `btn-generate-all` |
| Recommendations | Each table row | `rec-row-{intersection_id}` |
| Recommendations | Status badge per row | `badge-rec-status-{id}` |
| Recommendations | Detail sheet open | `sheet-rec-detail` |
| Signal Timing | Analyse button | `btn-analyse` |
| Signal Timing | TOD chunk tabs | `tab-chunk-{name}` (am, midday, pm, ev, ov, overall) |
| Signal Timing | Cycle length cell | `cell-cycle-{chunk_name}` |
| Signal Timing | Present mode button | `btn-present-mode` |
| Signal Timing | Edit timing button | `btn-edit-timing` |
| Signal Timing | 3D canvas container | `canvas-3d` |
| Dashboard | SSE connection status | `badge-sse-status` |
| Layout / Nav | Each nav link | `nav-link-intersections`, `nav-link-recommendations`, etc. |

---

## Step 2 - Test File Organisation

Split the single `app.spec.ts` into separate files, one per domain. Each
file is self-contained with its own auth helper and cleanup.

```
eyegila/e2e/
  playwright.config.ts          ← already exists, keep as-is
  helpers/
    auth.ts                     ← shared login() helper + getToken()
    api.ts                      ← direct API calls for setup/teardown
  specs/
    auth.spec.ts                ← login, logout, token expiry
    intersections.spec.ts       ← CRUD + wizard
    cameras.spec.ts             ← camera list, detail, status badge
    recommendations.spec.ts     ← generate, filter, detail sheet
    signal-timing.spec.ts       ← TOD chart, analyse, 3D view, present mode
    navigation.spec.ts          ← nav links, 404, redirect to login
    responsive.spec.ts          ← mobile viewport checks
```

---

## Step 3 - Test Scenarios by Page

### auth.spec.ts

| ID | Scenario | How |
|----|----------|-----|
| A-01 | Login page renders correctly | Visit `/login`, check username + password fields visible, Sign in button enabled |
| A-02 | Wrong password stays on login with error | Fill wrong pass, click Sign in, assert still on `/login`, error alert visible |
| A-03 | Empty fields prevented by browser | Click Sign in with empty fields, assert still on `/login` (HTML5 required) |
| A-04 | Valid login redirects away from login | Login with correct creds, assert URL not `/login` |
| A-05 | Unauthenticated direct navigation redirects to login | Go to `/`, assert redirected to `/login` |
| A-06 | Token persists across page reload | Login, reload, assert still authenticated (not redirected to login) |
| A-07 | Logout clears session | Login, click logout (if logout UI exists), assert redirected to `/login` |

---

### intersections.spec.ts

| ID | Scenario | How |
|----|----------|-----|
| I-01 | Intersections page loads with seeded data | Login, go to `/intersections`, assert at least one intersection card visible |
| I-02 | Grid view shows intersection names | Assert intersection name text visible in grid |
| I-03 | Map view renders a Leaflet map | Toggle to map view, assert `canvas` or `.leaflet-container` visible |
| I-04 | Add intersection button opens wizard | Click `btn-add-intersection`, assert wizard dialog opens (step label visible) |
| I-05 | Wizard step 1 - welcome/preview visible | Wizard open, assert step indicator shows step 1 |
| I-06 | Wizard step 2 - camera discovery fields visible | Advance to discover step, assert RTSP input visible |
| I-07 | Wizard step 3 - name and pin fields visible | Advance to name step, assert intersection name input + map present |
| I-08 | Wizard can be cancelled without creating anything | Open wizard, click X/cancel, assert no new intersection card appeared |
| I-09 | Clicking an intersection card navigates to detail | Click a card, assert URL matches `/intersections/{id}` |
| I-10 | Intersection detail page renders without JS errors | Navigate to detail, wait 2s, assert no page errors |

---

### cameras.spec.ts

| ID | Scenario | How |
|----|----------|-----|
| C-01 | Camera list page loads | Go to `/cameras`, assert page title visible, no JS errors |
| C-02 | Each camera row shows name + status badge | Assert `badge-camera-status` visible for each row |
| C-03 | Newly added camera has "offline" status | Add camera via API in beforeEach, reload, assert status badge shows "Offline" |
| C-04 | Clicking a camera navigates to its detail page | Click camera row, assert URL matches `/cameras/{id}` |
| C-05 | Camera detail page shows RTSP URL field | Navigate to camera detail, assert RTSP URL displayed |
| C-06 | Camera detail shows live feed container | Assert `feed-container` is in the DOM (feed itself may be blank in test env) |
| C-07 | Camera detail shows no fatal JS errors | Page error listener asserts zero errors on load |

---

### recommendations.spec.ts

| ID | Scenario | How |
|----|----------|-----|
| R-01 | Recommendations page loads without errors | Go to `/recommendations`, wait 2s, assert no JS errors |
| R-02 | Summary strip is visible | Assert SummaryStrip card or stat visible at top of page |
| R-03 | Table shows at least one row after seed | Assert at least one `rec-row-*` visible |
| R-04 | Status badges use known labels | Assert each status badge text is one of: Recommended, Monitor, Low Traffic, No Data |
| R-05 | Generate All button triggers loading state | Click `btn-generate-all`, assert button shows spinner/loading text |
| R-06 | Generate All completes and table refreshes | After generate-all finishes, assert rows still visible (no blank state) |
| R-07 | Search filter narrows results | Type intersection name in search, assert only matching rows visible |
| R-08 | Status filter toggles rows | Deselect "Recommended" status, assert recommended rows hidden |
| R-09 | Clicking a row opens detail sheet | Click a row, assert `sheet-rec-detail` slides open |
| R-10 | Detail sheet shows warrant breakdown | Assert W1, W2, W4 labels visible inside the sheet |
| R-11 | Detail sheet can be closed | Click close/X in sheet, assert sheet dismissed |

---

### signal-timing.spec.ts

| ID | Scenario | How |
|----|----------|-----|
| ST-01 | Signal Timing page loads for first intersection | Navigate via API to `/signal-timing/{id}`, assert no fatal JS errors |
| ST-02 | All 6 TOD chunk tabs are visible | Assert tabs: AM, Midday, PM, Evening, Overnight, Overall |
| ST-03 | Each tab shows a cycle length value | Click each tab, assert a number between 40–120 is visible |
| ST-04 | LOS grade badges appear (A–F) | Assert at least one text matching `/^[A-F]$/` is visible |
| ST-05 | Bar chart / histogram renders | Assert a `<svg>` or chart container is present and non-zero height |
| ST-06 | 3D canvas is mounted in the DOM | Assert `canvas-3d` or any `<canvas>` is attached |
| ST-07 | Analyse button triggers loading state | Click `btn-analyse`, assert spinner visible |
| ST-08 | Analyse completes without JS error | After analyse finishes (wait for spinner gone), assert no page errors |
| ST-09 | Edit timing dialog opens | Click `btn-edit-timing`, assert dialog with cycle input visible |
| ST-10 | Entering a cycle length and saving persists | Enter 80 in cycle input, save, assert "80" visible in timing table |
| ST-11 | Present mode fills the viewport | Click `btn-present-mode`, assert an overlay or fullscreen element is visible |
| ST-12 | Present mode can be exited | Press Escape or click close, assert overlay dismissed |

---

### navigation.spec.ts

| ID | Scenario | How |
|----|----------|-----|
| N-01 | Intersections nav link goes to `/intersections` | Click nav link, assert URL |
| N-02 | Recommendations nav link goes to `/recommendations` | Click nav link, assert URL |
| N-03 | Cameras nav link goes to `/cameras` | Click nav link, assert URL |
| N-04 | Unknown route shows fallback (not blank screen) | Navigate to `/xyz-unknown`, assert body has visible text |
| N-05 | Back navigation from detail returns to list | Go to detail page, click back arrow, assert back on list page |

---

### responsive.spec.ts

| ID | Scenario | Viewport | How |
|----|----------|----------|-----|
| RS-01 | Login page usable at 375×667 | Mobile S | Fields visible, button not clipped |
| RS-02 | Intersections list no horizontal overflow | Mobile S | `body.scrollWidth <= window.innerWidth` |
| RS-03 | Recommendations table scrollable at 375×667 | Mobile S | Table container has `overflow-x: auto` |
| RS-04 | Tablet layout at 768×1024 | Tablet | Nav and content both visible |
| RS-05 | Full desktop at 1440×900 | Desktop | No content clipped or overflowing |

---

## Step 4 - Shared Helpers to Write

### `helpers/auth.ts`

```
login(page)             - fills credentials, clicks Sign in, waits for redirect
getToken(page)          - reads eyegila_token from localStorage after login
authHeader(page)        - returns { Authorization: "Bearer <token>" }
```

### `helpers/api.ts`

Direct API calls for test setup and teardown (creates/deletes test data
without going through the UI, so tests are faster and deterministic).

```
createIntersection(token, name)   → { id }
deleteIntersection(token, id)
createCamera(token, name, iid)    → { id }
deleteCamera(token, id)
generateRecommendation(token, iid)
```

Using API helpers in `beforeEach`/`afterEach` keeps each spec independent.

---

## Step 5 - What to Test vs What to Skip

### Test with Playwright

- Page loads and renders without JS errors
- Login flow and auth protection
- Navigation between routes
- Interactive elements: buttons, tabs, filters, dialogs, sheets
- Text content that operators depend on: status labels, LOS grades, cycle lengths
- Responsive layout (no overflow, fields not clipped)
- Present mode overlay

### Skip / defer

- Live video feed (RTSP stream not available in test env - assert container exists, not the stream itself)
- WebGL 3D scene visual correctness (assert canvas is mounted, not pixel accuracy)
- Real-time SSE updates (flaky by nature - mock with API seed data instead)
- PDF / print output (assert button exists; visual output requires snapshot testing)
- ONVIF camera discovery (requires hardware - skip in automated tests)

---

## Step 6 - Running in CI

When running in CI (GitHub Actions, etc.), set these env vars:

```
BASE_URL=http://localhost:5173
API_URL=http://localhost:8000
ADMIN_USER=admin
ADMIN_PASS=admin
PLAYWRIGHT_OUTPUT_DIR=test-results
```

The config already reads `process.env.BASE_URL` and `process.env.API_URL`,
so no code changes are needed.

Add `make test-e2e` to the CI step that runs after `docker compose up -d`
and the seed script.

---

## Summary - What Exists vs What Is Planned

| Item | Status |
|------|--------|
| `eyegila/e2e/playwright.config.ts` | Exists |
| `eyegila/e2e/app.spec.ts` (basic smoke tests) | Exists |
| `data-testid` attributes on components | Not yet added |
| `helpers/auth.ts` + `helpers/api.ts` | Planned |
| `specs/auth.spec.ts` | Planned - 7 scenarios |
| `specs/intersections.spec.ts` | Planned - 10 scenarios |
| `specs/cameras.spec.ts` | Planned - 7 scenarios |
| `specs/recommendations.spec.ts` | Planned - 11 scenarios |
| `specs/signal-timing.spec.ts` | Planned - 12 scenarios |
| `specs/navigation.spec.ts` | Planned - 5 scenarios |
| `specs/responsive.spec.ts` | Planned - 5 scenarios |
| **Total planned scenarios** | **57** |
