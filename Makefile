.PHONY: test test-unit test-integration test-frontend test-e2e test-load

# ── Fast offline tests (no server needed, ~5 seconds total) ──────────────────
test-unit:
	python3 -m pytest tests/test_stress.py tests/test_pedestrian_timing.py \
	    tests/test_cycle_detection.py -q

# ── All Python tests (unit + integration) — needs: docker compose up -d ──────
# Integration tests auto-skip if server is unreachable (~60s with server)
test:
	python3 -m pytest -q

# ── Integration only — needs: docker compose up -d ───────────────────────────
test-integration:
	python3 -m pytest tests/test_integration_extended.py \
	    tests/test_recommendations.py tests/test_simulation.py \
	    tests/test_timing.py tests/test_auth.py tests/test_intersections.py \
	    tests/test_health.py -q

# ── Frontend unit tests (Vitest, jsdom, ~1 second) ───────────────────────────
test-frontend:
	cd eyegila && npm test

# ── Frontend E2E (Playwright) — needs: docker compose up -d + npm run dev ────
test-e2e:
	cd eyegila && npx playwright test --config e2e/playwright.config.ts

# ── k6 load test — needs: docker compose up -d + k6 installed ────────────────
# Install k6: sudo apt-get install k6
# Duration: ~90 seconds
test-load:
	k6 run k6/stress.js
