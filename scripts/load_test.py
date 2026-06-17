"""
EyeGila Load Test
=================
Tests the system under concurrent load to validate PgBouncer pool behaviour,
SSE scalability, aggregation query performance, and raw DB write throughput.

Tests
-----
write       Concurrent batch inserts via SQLAlchemy.
            Measures rows/sec and p50/p95/p99 batch latency.

sse         N concurrent SSE clients connected simultaneously.
            Measures time-to-first-event and event delivery lag.

api         Concurrent GET /aggregation/history requests (the heavy read path).
            Measures request latency percentiles.

pgbouncer   Open M simultaneous DB sessions through PgBouncer.
            Confirms pool limits and transaction-mode behaviour.

all         Run all four tests sequentially.

Usage
-----
# Write throughput – 8 workers, 200 batches each of 50 rows
python scripts/load_test.py write --workers 8 --batches 200 --batch-size 50

# SSE – 20 concurrent clients for 15 seconds
python scripts/load_test.py sse --clients 20 --duration 15

# API read – 30 concurrent clients, 50 requests each
python scripts/load_test.py api --clients 30 --requests 50

# PgBouncer pool – open 80 simultaneous connections
python scripts/load_test.py pgbouncer --connections 80

# Everything
python scripts/load_test.py all

Options
-------
--api-url   Server base URL    (default: http://localhost:8000)
--db-url    Direct DB DSN      (default: postgresql://postgres:postgres@localhost:5433/traffic)
--username  API username        (default: admin)
--password  API password        (default: admin)
"""

import argparse
import random
import sys
import time
import threading
import statistics
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

sys.path.append(".")


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def color(code: str, text: str) -> str:
    codes = {"green": "\033[32m", "yellow": "\033[33m", "cyan": "\033[36m",
             "red": "\033[31m", "bold": "\033[1m", "dim": "\033[2m", "reset": "\033[0m"}
    return f"{codes.get(code, '')}{text}{codes['reset']}"


def sep(title: str):
    pad = max(0, 56 - len(title)) // 2
    print(f"\n{'─' * pad}  {color('bold', title)}  {'─' * pad}")


def print_percentiles(label: str, samples: list[float], unit: str = "ms"):
    if not samples:
        print(f"  {label}: no data")
        return
    s = sorted(samples)
    n = len(s)
    p = lambda pct: s[min(int(n * pct / 100), n - 1)]
    avg = statistics.mean(s)
    print(
        f"  {label:<24}  "
        f"n={color('cyan', str(n))}  "
        f"avg={color('green', f'{avg:.1f}{unit}')}  "
        f"p50={p(50):.1f}{unit}  "
        f"p95={color('yellow', f'{p(95):.1f}{unit}')}  "
        f"p99={color('red', f'{p(99):.1f}{unit}')}  "
        f"max={p(100):.1f}{unit}"
    )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def login(api_url: str, username: str, password: str) -> str:
    r = requests.post(f"{api_url}/login",
                      json={"username": username, "password": password}, timeout=10)
    r.raise_for_status()
    return r.json()["token"]


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Test: DB write throughput
# ---------------------------------------------------------------------------

def _write_worker(db_url: str, batches: int, batch_size: int, worker_id: int,
                  results: list, lock: threading.Lock):
    """Insert batch_size detections in each of `batches` transactions."""
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(db_url, pool_size=1, max_overflow=0)
    Session = sessionmaker(bind=engine)
    db = Session()

    # Find a valid cctv_id and region_id to use
    row = db.execute(text("""
        SELECT r.cctv_id, r.id AS region_id
        FROM regions r
        LIMIT 1
    """)).first()

    if not row:
        with lock:
            print(color("red", f"  Worker {worker_id}: no regions found, skipping"))
        db.close()
        engine.dispose()
        return

    cctv_id, region_id = row.cctv_id, row.region_id
    latencies = []

    for _ in range(batches):
        now = datetime.now(timezone.utc)
        t0 = time.monotonic()

        # Bulk insert detections
        detection_rows = [
            {
                "cctv_id":     cctv_id,
                "track_id":    random.randint(1, 99999),
                "object_type": random.choice(["tricycle", "motorcycle", "car", "truck", "pedestrian"]),
                "confidence":  round(random.uniform(0.68, 0.99), 4),
                "x1": round(random.uniform(0.05, 0.5), 4),
                "y1": round(random.uniform(0.05, 0.5), 4),
                "x2": round(random.uniform(0.55, 0.95), 4),
                "y2": round(random.uniform(0.55, 0.95), 4),
                "time": now - timedelta(seconds=random.uniform(0, 60)),
            }
            for _ in range(batch_size)
        ]

        result = db.execute(
            text("""
                INSERT INTO detections (cctv_id, track_id, object_type, confidence,
                                        x1, y1, x2, y2, time)
                VALUES (:cctv_id, :track_id, :object_type, :confidence,
                        :x1, :y1, :x2, :y2, :time)
                RETURNING id, time
            """),
            detection_rows,
        )
        inserted_rows = result.fetchall()
        db.flush()

        # Bulk insert detection_in_regions
        dir_rows = [
            {"region_id": region_id, "detection_id": r.id, "time": r.time}
            for r in inserted_rows
        ]
        db.execute(
            text("""
                INSERT INTO detections_in_regions (region_id, detection_id, time)
                VALUES (:region_id, :detection_id, :time)
            """),
            dir_rows,
        )
        db.commit()

        latencies.append((time.monotonic() - t0) * 1000)

    db.close()
    engine.dispose()

    with lock:
        results.extend(latencies)


def run_write(args):
    sep("WRITE THROUGHPUT TEST")
    print(f"  Workers    : {args.workers}")
    print(f"  Batches    : {args.batches} per worker")
    print(f"  Batch size : {args.batch_size} detections")
    print(f"  Total rows : ~{args.workers * args.batches * args.batch_size:,}")
    print(f"  DB         : {args.db_url}\n")

    results: list[float] = []
    lock = threading.Lock()

    t0 = time.monotonic()
    threads = []
    for i in range(args.workers):
        t = threading.Thread(
            target=_write_worker,
            args=(args.db_url, args.batches, args.batch_size, i, results, lock),
        )
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    elapsed = time.monotonic() - t0
    total_rows = len(results) * args.batch_size

    print_percentiles("Batch commit latency", results)
    print(f"\n  Total time  : {elapsed:.1f}s")
    print(f"  Rows/sec    : {color('green', f'{total_rows / elapsed:,.0f}')}")
    print(f"  Batches/sec : {len(results) / elapsed:.1f}")


# ---------------------------------------------------------------------------
# Test: SSE concurrent clients
# ---------------------------------------------------------------------------

def _sse_client(api_url: str, token: str, duration: float, result: dict):
    """Connect to SSE endpoint, record time-to-first-event and total events."""
    import json
    hdrs = {**auth_headers(token), "Accept": "text/event-stream"}
    first_event_ms = None
    event_count = 0
    t_connect = time.monotonic()

    try:
        with requests.get(
            f"{api_url}/aggregation/stream",
            headers=hdrs,
            stream=True,
            timeout=(5, duration + 2),
        ) as resp:
            resp.raise_for_status()
            t_connected = time.monotonic()
            deadline = t_connected + duration

            for chunk in resp.iter_lines(chunk_size=1024):
                if time.monotonic() > deadline:
                    break
                if chunk and chunk.startswith(b"data:"):
                    if first_event_ms is None:
                        first_event_ms = (time.monotonic() - t_connect) * 1000
                    try:
                        json.loads(chunk[5:])
                        event_count += 1
                    except Exception:
                        pass

        result["first_event_ms"] = first_event_ms
        result["event_count"]    = event_count
        result["ok"]             = True
    except Exception as e:
        result["error"]          = str(e)
        result["ok"]             = False


def run_sse(args):
    sep("SSE CONCURRENT CLIENT TEST")
    print(f"  Clients  : {args.clients}")
    print(f"  Duration : {args.duration}s per client")
    print(f"  Endpoint : {args.api_url}/aggregation/stream\n")

    token = login(args.api_url, args.username, args.password)
    results = [{} for _ in range(args.clients)]
    threads = []

    print(f"  {color('yellow', '▶')} Connecting {args.clients} clients simultaneously …")
    t0 = time.monotonic()

    for i in range(args.clients):
        t = threading.Thread(target=_sse_client,
                             args=(args.api_url, token, args.duration, results[i]))
        threads.append(t)

    for t in threads:
        t.start()
    for t in threads:
        t.join()

    elapsed = time.monotonic() - t0
    ok     = [r for r in results if r.get("ok")]
    failed = [r for r in results if not r.get("ok")]

    fte = [r["first_event_ms"] for r in ok if r.get("first_event_ms") is not None]
    event_counts = [r.get("event_count", 0) for r in ok]

    print(f"\n  Connected  : {color('green', str(len(ok)))} / {args.clients}")
    if failed:
        print(f"  Failed     : {color('red', str(len(failed)))}")
        for r in failed[:3]:
            print(f"    {r.get('error', 'unknown')}")

    print_percentiles("Time-to-first-event", fte)
    if event_counts:
        print(f"  Events/client  : avg={statistics.mean(event_counts):.1f}  "
              f"min={min(event_counts)}  max={max(event_counts)}")
    print(f"\n  Wall time  : {elapsed:.1f}s")


# ---------------------------------------------------------------------------
# Test: API read throughput (aggregation/history)
# ---------------------------------------------------------------------------

def _api_read_worker(api_url: str, token: str, n_requests: int,
                     intersection_ids: list[int], results: list, lock: threading.Lock):
    hdrs = auth_headers(token)
    latencies = []
    errors = 0

    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=7)).isoformat()
    end   = now.isoformat()

    for _ in range(n_requests):
        params = {"start": start, "end": end, "bucket": "hour"}
        if intersection_ids:
            params["intersection_id"] = random.choice(intersection_ids)

        t0 = time.monotonic()
        try:
            r = requests.get(f"{api_url}/aggregation/history",
                             params=params, headers=hdrs, timeout=30)
            r.raise_for_status()
            latencies.append((time.monotonic() - t0) * 1000)
        except Exception:
            errors += 1

    with lock:
        results.append({"latencies": latencies, "errors": errors})


def run_api(args):
    sep("API READ THROUGHPUT TEST")
    print(f"  Clients      : {args.clients}")
    print(f"  Requests/client: {args.requests}")
    print(f"  Total requests : {args.clients * args.requests:,}")
    print(f"  Endpoint     : GET /aggregation/history\n")

    token = login(args.api_url, args.username, args.password)

    # Collect intersection IDs to scatter queries
    r = requests.get(f"{args.api_url}/intersections/", timeout=10)
    r.raise_for_status()
    intersection_ids = [i["id"] for i in r.json()]

    results: list[dict] = []
    lock = threading.Lock()
    t0 = time.monotonic()

    with ThreadPoolExecutor(max_workers=args.clients) as pool:
        futs = [
            pool.submit(_api_read_worker, args.api_url, token,
                        args.requests, intersection_ids, results, lock)
            for _ in range(args.clients)
        ]
        for f in as_completed(futs):
            f.result()

    elapsed = time.monotonic() - t0
    all_latencies = [l for r in results for l in r["latencies"]]
    total_errors  = sum(r["errors"] for r in results)
    total_ok      = len(all_latencies)

    print_percentiles("Request latency", all_latencies)
    print(f"\n  Completed  : {color('green', str(total_ok))}")
    if total_errors:
        print(f"  Errors     : {color('red', str(total_errors))}")
    print(f"  Throughput : {color('green', f'{total_ok / elapsed:.1f} req/s')}")
    print(f"  Wall time  : {elapsed:.1f}s")


# ---------------------------------------------------------------------------
# Test: PgBouncer connection pool pressure
# ---------------------------------------------------------------------------

def _pgbouncer_worker(db_url: str, result: dict):
    """Open one DB session, run a simple query, record latency."""
    from sqlalchemy import create_engine, text
    t0 = time.monotonic()
    try:
        engine = create_engine(db_url, pool_size=1, max_overflow=0,
                               connect_args={"connect_timeout": 10})
        with engine.connect() as conn:
            row = conn.execute(text("SELECT COUNT(*) FROM detections")).scalar()
        result["latency_ms"] = (time.monotonic() - t0) * 1000
        result["count"]      = row
        result["ok"]         = True
        engine.dispose()
    except Exception as e:
        result["error"] = str(e)
        result["ok"]    = False


def run_pgbouncer(args):
    sep("PGBOUNCER POOL PRESSURE TEST")
    print(f"  Connections  : {args.connections} simultaneous")
    print(f"  DB           : {args.db_url}")
    print(f"  (PgBouncer default pool = 25; expect queuing above that)\n")

    results = [{} for _ in range(args.connections)]
    threads = []
    t0 = time.monotonic()

    for i in range(args.connections):
        t = threading.Thread(target=_pgbouncer_worker, args=(args.db_url, results[i]))
        threads.append(t)

    print(f"  {color('yellow', '▶')} Opening {args.connections} connections …")
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    elapsed = time.monotonic() - t0
    ok      = [r for r in results if r.get("ok")]
    failed  = [r for r in results if not r.get("ok")]
    lats    = [r["latency_ms"] for r in ok]

    print(f"\n  Succeeded  : {color('green', str(len(ok)))} / {args.connections}")
    if failed:
        print(f"  Failed     : {color('red', str(len(failed)))}")
        for r in failed[:5]:
            print(f"    {r.get('error', 'unknown error')}")

    print_percentiles("Query round-trip", lats)
    print(f"\n  Wall time  : {elapsed:.1f}s")
    if len(ok) == args.connections:
        print(f"  {color('green', '✓')} All connections succeeded - pool handled the load.")
    else:
        print(f"  {color('yellow', '⚠')} Some connections failed - pool may be exhausted or server overloaded.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="EyeGila load test",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("test", choices=["write", "sse", "api", "pgbouncer", "all"],
                        help="Which test to run")

    parser.add_argument("--api-url",     default="http://localhost:8000")
    parser.add_argument("--db-url",      default="postgresql://postgres:postgres@localhost:5433/traffic")
    parser.add_argument("--username",    default="admin")
    parser.add_argument("--password",    default="admin")

    # write
    parser.add_argument("--workers",     type=int, default=4,
                        help="Concurrent DB writer threads (default: 4)")
    parser.add_argument("--batches",     type=int, default=100,
                        help="Batches per writer (default: 100)")
    parser.add_argument("--batch-size",  type=int, default=50,
                        help="Detections per batch (default: 50)")

    # sse
    parser.add_argument("--clients",     type=int, default=10,
                        help="Concurrent SSE/API clients (default: 10)")
    parser.add_argument("--duration",    type=float, default=15,
                        help="SSE connection duration in seconds (default: 15)")

    # api
    parser.add_argument("--requests",   type=int, default=50,
                        help="API requests per client (default: 50)")

    # pgbouncer
    parser.add_argument("--connections", type=int, default=50,
                        help="Simultaneous DB connections (default: 50)")

    args = parser.parse_args()

    print(color("bold", "\n  EyeGila Load Test") + f"  [{args.test}]\n")

    tests = {
        "write":      run_write,
        "sse":        run_sse,
        "api":        run_api,
        "pgbouncer":  run_pgbouncer,
    }

    if args.test == "all":
        run_write(args)
        run_api(args)
        run_pgbouncer(args)
        run_sse(args)
    else:
        tests[args.test](args)

    print()


if __name__ == "__main__":
    main()
