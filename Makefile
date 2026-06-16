.PHONY: test test-unit test-integration test-functionality test-frontend test-e2e test-load \
        dev dev-mac dev-mac-down dev-mac-logs

# ── Standard dev stack (requires NVIDIA GPU for worker) ──────────────────────
dev:
	docker compose up --build -d

# ── Mac / CPU-only dev stack (no GPU required) ────────────────────────────────
# Starts the full stack with CPU-only workers:
#   • rq-worker uses rq-worker/Dockerfile.mac (onnxruntime CPU, no TensorRT)
#   • --profile worker starts the CPU live-camera worker
# Copy .env.example to .env first and ensure eyegila_v4.pt is in the root.
dev-mac:
	RQ_WORKER_DOCKERFILE=rq-worker/Dockerfile.mac \
	  docker compose --profile worker up --build -d

dev-mac-logs:
	docker compose --profile worker logs -f

dev-mac-down:
	docker compose --profile worker down

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

# ── Functionality tests (end-to-end user flows) — needs: docker compose up -d ─
test-functionality:
	python3 -m pytest tests/test_functionality.py -v

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
