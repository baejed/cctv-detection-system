#!/usr/bin/env bash
# Production-level E2E test runner — spins up the full stack in Docker,
# seeds test data, runs pytest (backend) + Playwright (frontend), then tears down.
#
# Usage:
#   ./scripts/run-tests.sh              # run everything
#   ./scripts/run-tests.sh --no-build   # skip docker build (use cached images)
#   ./scripts/run-tests.sh --pytest     # run backend tests only
#   ./scripts/run-tests.sh --playwright # run e2e tests only

set -euo pipefail

PROJECT=eyegila-test
COMPOSE="docker compose -f docker-compose.test.yml -p $PROJECT"
RESULTS_DIR="test-results"
BUILD_FLAG="--build"
RUN_PYTEST=true
RUN_PLAYWRIGHT=true

# ── Parse flags ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --no-build)   BUILD_FLAG="" ;;
    --pytest)     RUN_PLAYWRIGHT=false ;;
    --playwright) RUN_PYTEST=false ;;
  esac
done

# ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "--- Tearing down test stack..."
  $COMPOSE down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# ── Preparation ───────────────────────────────────────────────────────────────
mkdir -p "$RESULTS_DIR/playwright"

echo "============================================================"
echo "  EyeGila — Production E2E Test Suite"
echo "============================================================"

# ── Build images ──────────────────────────────────────────────────────────────
if [ -n "$BUILD_FLAG" ]; then
  echo ""
  echo "--- Building images..."
  $COMPOSE build
fi

# ── Start the full stack — depends_on handles ordering:
#    timescaledb → migrations → server → seeder → pytest / playwright
#    timescaledb → pgbouncer  → server
#    server      → frontend   → playwright
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "--- Starting stack (migrations → seed → tests run automatically)..."
$COMPOSE up -d

# ── Stream logs while waiting for test containers to finish ───────────────────
echo "--- Waiting for test containers to finish..."

# show live log from seeder so we can see seed progress
$COMPOSE logs -f seeder &
SEEDER_LOG_PID=$!

# wait for seeder to exit
SEEDER_CID="eyegila-test-seeder"
until [ "$(docker inspect --format='{{.State.Status}}' "$SEEDER_CID" 2>/dev/null)" = "exited" ]; do
  sleep 2
done
kill $SEEDER_LOG_PID 2>/dev/null || true

SEEDER_EXIT=$(docker inspect --format='{{.State.ExitCode}}' "$SEEDER_CID" 2>/dev/null || echo 1)
if [ "$SEEDER_EXIT" != "0" ]; then
  echo "ERROR: Seeder failed (exit $SEEDER_EXIT). Aborting."
  $COMPOSE logs seeder
  exit 1
fi

echo "--- Seeder complete."

# ── Wait for test runners ─────────────────────────────────────────────────────
PYTEST_EXIT=0
PLAYWRIGHT_EXIT=0

if [ "$RUN_PYTEST" = true ]; then
  echo ""
  echo "--- Streaming pytest output..."
  $COMPOSE logs -f pytest || true
  PYTEST_EXIT=$(docker inspect --format='{{.State.ExitCode}}' "eyegila-test-pytest" 2>/dev/null || echo 1)
fi

if [ "$RUN_PLAYWRIGHT" = true ]; then
  echo ""
  echo "--- Streaming playwright output..."
  $COMPOSE logs -f playwright || true
  PLAYWRIGHT_EXIT=$(docker inspect --format='{{.State.ExitCode}}' "eyegila-test-playwright" 2>/dev/null || echo 1)

  # Copy HTML report out of container
  PLAYWRIGHT_CID=$(docker ps -aqf "name=eyegila-test-playwright" 2>/dev/null || true)
  if [ -n "$PLAYWRIGHT_CID" ]; then
    docker cp "${PLAYWRIGHT_CID}:/app/playwright-report/." "$RESULTS_DIR/playwright/" 2>/dev/null || true
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Test Results"
echo "============================================================"

if [ "$RUN_PYTEST" = true ]; then
  [ "$PYTEST_EXIT" -eq 0 ] && echo "  Backend  (pytest):     PASS" \
                            || echo "  Backend  (pytest):     FAIL (exit $PYTEST_EXIT)"
fi

if [ "$RUN_PLAYWRIGHT" = true ]; then
  [ "$PLAYWRIGHT_EXIT" -eq 0 ] && echo "  Frontend (playwright): PASS" \
                                || echo "  Frontend (playwright): FAIL (exit $PLAYWRIGHT_EXIT)"
  echo "  Report: $RESULTS_DIR/playwright/"
fi

echo "============================================================"

# ── Exit non-zero if any suite failed ─────────────────────────────────────────
[ "$PYTEST_EXIT" -eq 0 ] && [ "$PLAYWRIGHT_EXIT" -eq 0 ]
