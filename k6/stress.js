/**
 * k6 load test for EyeGila - simulates 100 concurrent traffic engineers.
 *
 * Usage:
 *   k6 run k6/stress.js
 *   k6 run --vus 100 --duration 60s k6/stress.js
 *   API_URL=http://staging:8000 k6 run k6/stress.js
 *
 * Install k6: https://k6.io/docs/getting-started/installation/
 *   Ubuntu/WSL: sudo gpg -k; sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
 *              echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
 *              sudo apt-get update && sudo apt-get install k6
 */
import http from 'k6/http';
import { sleep, check, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ─── Config ──────────────────────────────────────────────────────────────────

const API_URL    = __ENV.API_URL   || 'http://localhost:8000';
const ADMIN_USER = __ENV.ADMIN_USER || 'admin';
const ADMIN_PASS = __ENV.ADMIN_PASS || 'admin';

// ─── Custom metrics ───────────────────────────────────────────────────────────

const generateLatency    = new Trend('generate_rec_latency',   true);
const generateAllLatency = new Trend('generate_all_latency',   true);
const simLatency         = new Trend('simulation_latency',     true);
const timingLatency      = new Trend('timing_latency',         true);
const listLatency        = new Trend('list_latency',           true);
const errorRate          = new Rate('error_rate');
const totalRequests      = new Counter('total_requests');

// ─── Thresholds (what "passing" means) ───────────────────────────────────────

export const options = {
  scenarios: {
    // Ramp up to 50 VUs over 15s, hold for 30s, ramp down
    steady_load: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '15s', target: 20 },  // ramp up
        { duration: '30s', target: 50 },  // hold at 50 VUs
        { duration: '15s', target: 0 },   // ramp down
      ],
    },
    // Spike test: 100 VUs all at once for 10s
    spike: {
      executor: 'constant-vus',
      vus: 100,
      duration: '10s',
      startTime: '65s',  // starts after steady load ends
    },
  },
  thresholds: {
    // p95 of most endpoints < 2s; generate-all is slower (DB + ML)
    'generate_rec_latency{p:95}':    ['p(95)<2000'],
    'generate_all_latency{p:95}':    ['p(95)<10000'],
    'simulation_latency{p:95}':      ['p(95)<1000'],
    'timing_latency{p:95}':          ['p(95)<1000'],
    'list_latency{p:95}':            ['p(95)<500'],
    'error_rate':                    ['rate<0.01'],  // <1% error rate
    'http_req_failed':               ['rate<0.01'],
  },
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getToken() {
  const res = http.post(
    `${API_URL}/login`,
    JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'login 200': (r) => r.status === 200 });
  if (res.status !== 200) return null;
  return res.json('token');
}

function authHeaders(token) {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function listIntersections(token) {
  const res = http.get(`${API_URL}/intersections/`, { headers: authHeaders(token) });
  totalRequests.add(1);
  check(res, { 'intersections 200': (r) => r.status === 200 });
  return res.status === 200 ? res.json() : [];
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Main VU logic ────────────────────────────────────────────────────────────

export default function () {
  // Each VU authenticates independently (tests auth scalability)
  const token = getToken();
  if (!token) {
    errorRate.add(1);
    return;
  }
  errorRate.add(0);

  const intersections = listIntersections(token);
  if (!intersections.length) {
    console.warn('No intersections found - seed data required');
    return;
  }

  // Pick a random intersection to spread load
  const intersection = pickRandom(intersections);
  const iid = intersection.id;

  group('list endpoints', () => {
    // GET /recommendations/
    const t0 = Date.now();
    const recList = http.get(`${API_URL}/recommendations/`, { headers: authHeaders(token) });
    listLatency.add(Date.now() - t0);
    totalRequests.add(1);
    check(recList, { 'rec list 200': (r) => r.status === 200 });

    // GET /timing-recommendations/{id}
    const t1 = Date.now();
    const timing = http.get(`${API_URL}/timing-recommendations/${iid}`, { headers: authHeaders(token) });
    timingLatency.add(Date.now() - t1);
    totalRequests.add(1);
    check(timing, { 'timing list 200 or 404': (r) => r.status === 200 || r.status === 404 });
  });

  group('generate recommendation', () => {
    const t = Date.now();
    const res = http.post(
      `${API_URL}/recommendations/generate/${iid}`,
      null,
      { headers: authHeaders(token) },
    );
    generateLatency.add(Date.now() - t);
    totalRequests.add(1);

    const ok = check(res, {
      'generate 200':        (r) => r.status === 200,
      'has recommended key': (r) => r.status === 200 && r.json('recommended') !== undefined,
      'has timing_cycle':    (r) => r.status === 200 && 'timing_cycle' in r.json(),
    });
    if (!ok) errorRate.add(1);
    else errorRate.add(0);
  });

  group('simulation', () => {
    const t = Date.now();
    const res = http.get(
      `${API_URL}/simulation/${iid}`,
      { headers: authHeaders(token) },
    );
    simLatency.add(Date.now() - t);
    totalRequests.add(1);
    check(res, {
      'simulation 200 or 404': (r) => r.status === 200 || r.status === 404,
    });
    if (res.status === 200) {
      const body = res.json();
      check(body, {
        'has chunks':        (b) => Array.isArray(b.chunks),
        'has daily_summary': (b) => !!b.daily_summary,
        'los valid':         (b) => /^[A-F]$/.test(b.daily_summary?.los_after ?? 'X'),
      });
    }
  });

  group('history endpoint', () => {
    const t = Date.now();
    const res = http.get(
      `${API_URL}/recommendations/history/${iid}?limit=10`,
      { headers: authHeaders(token) },
    );
    listLatency.add(Date.now() - t);
    totalRequests.add(1);
    check(res, { 'history 200': (r) => r.status === 200 });
  });

  sleep(0.5 + Math.random() * 1.5);  // 0.5–2s think time between iterations
}

// ─── Generate-all soak scenario (separate run) ────────────────────────────────

export function generateAllSoak() {
  const token = getToken();
  if (!token) { errorRate.add(1); return; }

  const t = Date.now();
  const res = http.post(
    `${API_URL}/recommendations/generate-all`,
    null,
    { headers: authHeaders(token), timeout: '30s' },
  );
  generateAllLatency.add(Date.now() - t);
  totalRequests.add(1);

  const ok = check(res, {
    'generate-all 200':  (r) => r.status === 200,
    'returns array':     (r) => r.status === 200 && Array.isArray(r.json()),
    'at least 1 result': (r) => r.status === 200 && r.json().length >= 1,
  });
  if (!ok) errorRate.add(1);
  else     errorRate.add(0);

  sleep(5);  // generate-all is expensive; don't hammer it
}

/**
 * To run only the generate-all soak:
 *   k6 run --export=generateAllSoak k6/stress.js
 */
