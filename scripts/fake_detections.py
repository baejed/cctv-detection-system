"""
Fake Detection Script
=====================
Inserts realistic fake detection data for testing the aggregation pipeline,
SSE stream, and frontend charts before the real worker is integrated.

Usage
-----
# Seed base data (3 intersections, 4 streets each, 4 CCTVs each, regions)
# Safe to run multiple times -skips intersections that already exist.
python scripts/fake_detections.py --seed

# Fill ALL cameras/regions with 14 days of traffic (default)
python scripts/fake_detections.py --fill

# Seed + fill in one shot (recommended for a clean DB)
python scripts/fake_detections.py --full

# Fill a specific number of days
python scripts/fake_detections.py --fill --days 7

# Fill a specific camera/region (legacy)
python scripts/fake_detections.py --cctv-id 1 --region-id 1 --count 500 --hours 2

# List what's in the database
python scripts/fake_detections.py --list
"""

import argparse
import random
import sys
from datetime import datetime, timedelta, timezone

sys.path.append(".")

from common.database import SessionLocal
from common.models import (
    CCTV,
    Detection,
    DetectionInRegion,
    Intersection,
    Region,
    RegionPoint,
    Street,
)
from server.tod import seed_tod_chunks

OBJECT_TYPES = ["tricycle", "motorcycle", "car", "truck", "pedicab", "pedestrian"]

DEFAULT_WEIGHTS = {
    "tricycle":   0.35,
    "motorcycle": 0.30,
    "car":        0.15,
    "truck":      0.05,
    "pedicab":    0.10,
    "pedestrian": 0.05,
}

# ---------------------------------------------------------------------------
# Realistic traffic patterns
# ---------------------------------------------------------------------------

# Fraction of peak-hour volume for each hour of the day (0–23)
HOUR_MULTIPLIERS = {
    0:  0.04,   # midnight -nearly empty
    1:  0.02,
    2:  0.02,
    3:  0.02,
    4:  0.05,   # early market vendors
    5:  0.15,
    6:  0.45,   # morning ramp-up
    7:  0.85,   # AM peak
    8:  1.00,   # AM peak
    9:  0.70,
    10: 0.60,
    11: 0.65,
    12: 0.75,   # lunch
    13: 0.60,
    14: 0.55,
    15: 0.65,
    16: 0.85,   # PM peak starts
    17: 1.00,   # PM peak
    18: 0.90,
    19: 0.70,
    20: 0.50,
    21: 0.35,
    22: 0.20,
    23: 0.10,
}

WEEKDAY_MULTIPLIER = 1.0   # Mon–Fri
WEEKEND_MULTIPLIER = 0.65  # Sat–Sun (lighter traffic)

# Peak-hour base detections per camera per hour.
# With 4 cameras at an intersection summing counts, this gives ~320–400/hr
# at the intersection level during peak -enough to meet Warrant 1 (300/hr × 8 hrs).
PEAK_DETECTIONS_PER_CAMERA_PER_HOUR = 90

# ---------------------------------------------------------------------------
# Intersections to seed -real Tagum City locations
# ---------------------------------------------------------------------------

MEDIAMTX_HOST = "192.168.254.104"

SEED_INTERSECTIONS = [
    {
        "name": "Tagum City Hall Junction",
        "latitude":  7.4478,
        "longitude": 125.8112,
        "streets": [
            {
                "name": "Northbound -Apokon Road",
                "cam_name": "Cam A1 -Apokon Northbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam1",
            },
            {
                "name": "Southbound -Apokon Road",
                "cam_name": "Cam A2 -Apokon Southbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam2",
            },
            {
                "name": "Eastbound -Lapu-Lapu Street",
                "cam_name": "Cam A3 -Lapu-Lapu Eastbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam3",
            },
            {
                "name": "Westbound -Lapu-Lapu Street",
                "cam_name": "Cam A4 -Lapu-Lapu Westbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam4",
            },
        ],
    },
    {
        "name": "Tagum Public Market Junction",
        "latitude":  7.4453,
        "longitude": 125.8091,
        "streets": [
            {
                "name": "Northbound -Rizal Street",
                "cam_name": "Cam B1 -Rizal Northbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam1",
            },
            {
                "name": "Southbound -Rizal Street",
                "cam_name": "Cam B2 -Rizal Southbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam2",
            },
            {
                "name": "Eastbound -Coryville Road",
                "cam_name": "Cam B3 -Coryville Eastbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam3",
            },
            {
                "name": "Westbound -Coryville Road",
                "cam_name": "Cam B4 -Coryville Westbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam4",
            },
        ],
    },
    {
        "name": "Magugpo Poblacion Junction",
        "latitude":  7.4512,
        "longitude": 125.8155,
        "streets": [
            {
                "name": "Northbound -National Highway",
                "cam_name": "Cam C1 -Highway Northbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam1",
            },
            {
                "name": "Southbound -National Highway",
                "cam_name": "Cam C2 -Highway Southbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam2",
            },
            {
                "name": "Eastbound -Dahlia Street",
                "cam_name": "Cam C3 -Dahlia Eastbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam3",
            },
            {
                "name": "Westbound -Dahlia Street",
                "cam_name": "Cam C4 -Dahlia Westbound",
                "stream": f"rtsp://{MEDIAMTX_HOST}:8554/cam4",
            },
        ],
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_weights(raw: str) -> dict:
    result = {}
    for pair in raw.split(","):
        key, val = pair.strip().split("=")
        result[key.strip()] = float(val.strip())
    total = sum(result.values())
    return {k: v / total for k, v in result.items()}


def random_object_type(weights: dict) -> str:
    types = list(weights.keys())
    probs = [weights[t] for t in types]
    return random.choices(types, weights=probs, k=1)[0]


def random_bounding_box():
    x1 = round(random.uniform(0.1, 0.7), 4)
    y1 = round(random.uniform(0.1, 0.7), 4)
    x2 = round(min(x1 + random.uniform(0.05, 0.2), 1.0), 4)
    y2 = round(min(y1 + random.uniform(0.05, 0.2), 1.0), 4)
    return x1, y1, x2, y2


def detections_for_hour(ts: datetime) -> int:
    """
    Calculate how many detections to generate for a given hour timestamp,
    using time-of-day and day-of-week patterns.
    """
    hour_factor = HOUR_MULTIPLIERS[ts.hour]
    dow_factor  = WEEKEND_MULTIPLIER if ts.weekday() >= 5 else WEEKDAY_MULTIPLIER
    # ±15% jitter so each hour isn't identical
    jitter = random.uniform(0.85, 1.15)
    count = PEAK_DETECTIONS_PER_CAMERA_PER_HOUR * hour_factor * dow_factor * jitter
    return max(0, round(count))


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------

def seed_base_data(db) -> list[tuple]:
    """
    Create intersections, streets, CCTVs, and regions.
    Idempotent: skips intersections whose name already exists.
    Returns list of (cctv_id, region_id) tuples that were created or already existed.
    """
    print("Seeding base data …")
    print(f"  MediaMTX host: {MEDIAMTX_HOST}")
    print()

    camera_region_pairs: list[tuple[int, int]] = []

    for spec in SEED_INTERSECTIONS:
        existing = db.query(Intersection).filter_by(name=spec["name"]).first()
        if existing:
            print(f"  [skip] Intersection '{spec['name']}' already exists (id={existing.id})")
            # Still collect existing camera/region pairs for --fill
            for cctv in existing.cctvs:
                for region in cctv.regions:
                    camera_region_pairs.append((cctv.id, region.id))
            continue

        intersection = Intersection(
            name=spec["name"],
            latitude=spec["latitude"],
            longitude=spec["longitude"],
        )
        db.add(intersection)
        db.flush()
        seed_tod_chunks(db, intersection.id)
        print(f"  Intersection id={intersection.id} '{intersection.name}' "
              f"({intersection.latitude}, {intersection.longitude})")

        for s in spec["streets"]:
            street = Street(intersection_id=intersection.id, name=s["name"])
            db.add(street)
            db.flush()

            cctv = CCTV(
                intersection_id=intersection.id,
                name=s["cam_name"],
                rtsp_url=s["stream"],
                status="offline",
            )
            db.add(cctv)
            db.flush()

            region = Region(cctv_id=cctv.id, street_id=street.id)
            db.add(region)
            db.flush()

            # Full-frame polygon (normalized 0–1)
            for x, y in [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]:
                db.add(RegionPoint(region_id=region.id, x=x, y=y))

            camera_region_pairs.append((cctv.id, region.id))
            print(f"    Street '{street.name}' → CCTV id={cctv.id} → Region id={region.id}")

    db.commit()
    print()
    return camera_region_pairs


# ---------------------------------------------------------------------------
# Fill (bulk insert with traffic patterns)
# ---------------------------------------------------------------------------

def fill_all(db, days: int, weights: dict):
    """
    Generate `days` days of realistic detections for every camera/region in the DB.
    Skips hours that already have detections to avoid doubling up on re-runs.
    """
    from sqlalchemy import text

    # Collect all (cctv_id, region_id) pairs
    pairs = []
    for region in db.query(Region).all():
        pairs.append((region.cctv_id, region.id))

    if not pairs:
        print("No cameras/regions found -run --seed first.")
        return

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = now -timedelta(days=days)

    total_inserted = 0

    print(f"Filling {days} days of traffic data for {len(pairs)} camera/region pairs …")
    print(f"  Range: {start.strftime('%Y-%m-%d %H:%M')} → {now.strftime('%Y-%m-%d %H:%M')} UTC")
    print()

    for pair_idx, (cctv_id, region_id) in enumerate(pairs):
        hour_cursor = start
        pair_inserted = 0

        while hour_cursor < now:
            hour_end = hour_cursor + timedelta(hours=1)

            # Skip this hour if detections already exist for this camera
            existing = db.execute(
                text("SELECT 1 FROM detections WHERE cctv_id = :cid AND time >= :start AND time < :end LIMIT 1"),
                {"cid": cctv_id, "start": hour_cursor, "end": hour_end},
            ).first()
            if existing:
                hour_cursor = hour_end
                continue

            count = detections_for_hour(hour_cursor)
            if count == 0:
                hour_cursor += timedelta(hours=1)
                continue

            detections = []
            for _ in range(count):
                object_type = random_object_type(weights)
                x1, y1, x2, y2 = random_bounding_box()
                offset_secs = random.uniform(0, 3599)
                detected_at = hour_cursor + timedelta(seconds=offset_secs)

                detections.append(Detection(
                    cctv_id=cctv_id,
                    track_id=random.randint(1, 99999),
                    object_type=object_type,
                    confidence=round(random.uniform(0.65, 0.99), 4),
                    x1=x1, y1=y1, x2=x2, y2=y2,
                    time=detected_at,
                ))

            db.add_all(detections)
            db.flush()

            links = [
                DetectionInRegion(region_id=region_id, detection_id=d.id, time=d.time)
                for d in detections
            ]
            db.add_all(links)
            db.flush()

            pair_inserted += len(detections)
            hour_cursor += timedelta(hours=1)

        db.commit()
        total_inserted += pair_inserted
        print(f"  [{pair_idx + 1}/{len(pairs)}] CCTV {cctv_id} / Region {region_id} "
              f"→ {pair_inserted:,} detections")

    print()
    print(f"Done. Total inserted: {total_inserted:,} detections across {len(pairs)} regions.")
    print()
    print("TimescaleDB continuous aggregate refreshes every 1 minute.")
    print("After ~1 minute, query to verify:")
    print("  SELECT * FROM aggregation_summaries ORDER BY window_start DESC LIMIT 20;")


# ---------------------------------------------------------------------------
# Single camera insert (legacy mode)
# ---------------------------------------------------------------------------

def insert_detections(db, cctv_id, region_id, count, hours, weights):
    now = datetime.now(timezone.utc)
    start = now -timedelta(hours=hours)

    detections = []
    for _ in range(count):
        object_type = random_object_type(weights)
        x1, y1, x2, y2 = random_bounding_box()
        offset = random.uniform(0, hours * 3600)
        detected_at = start + timedelta(seconds=offset)

        detections.append(Detection(
            cctv_id=cctv_id,
            track_id=random.randint(1, 9999),
            object_type=object_type,
            confidence=round(random.uniform(0.65, 0.99), 4),
            x1=x1, y1=y1, x2=x2, y2=y2,
            time=detected_at,
        ))

    db.add_all(detections)
    db.flush()

    links = [
        DetectionInRegion(region_id=region_id, detection_id=d.id, time=d.time)
        for d in detections
    ]
    db.add_all(links)
    db.commit()

    return len(detections)


# ---------------------------------------------------------------------------
# Scenario seeding (warranted + borderline demo intersections)
# ---------------------------------------------------------------------------

# Feature targets determined by probing the warrant MLP directly:
#   Warranted:  major≈650, minor≈280, peds≈49, vpm≈11, phf≈1.0 → rec=1.000
#   Borderline: major≈500, minor≈165, peds≈35, vpm≈9,  phf≈1.0 → rec=0.491, w1=0.320
#
# Detections are inserted without jitter so the aggregate for the last complete
# hour is deterministic.  Run the analysis from the UI after ~60 s for the
# TimescaleDB continuous aggregate to refresh.

SCENARIO_INTERSECTIONS = [
    {
        "name": "Visayan Avenue Junction",
        "latitude":  7.4521,
        "longitude": 125.8133,
        "expected": "warranted",
        "streets": [
            # dominant approach drives major_volume ≈ 650
            {"name": "Northbound — Visayan Ave",  "cam": "Cam V1 — Visayan NB", "peak": 684},
            {"name": "Southbound — Visayan Ave",  "cam": "Cam V2 — Visayan SB", "peak": 98},
            {"name": "Eastbound — Digos Road",    "cam": "Cam V3 — Digos EB",   "peak": 98},
            {"name": "Westbound — Digos Road",    "cam": "Cam V4 — Digos WB",   "peak": 98},
        ],
    },
    {
        "name": "Caryving Road Junction",
        "latitude":  7.4498,
        "longitude": 125.8071,
        "expected": "borderline",
        "streets": [
            # dominant approach drives major_volume ≈ 500
            {"name": "Northbound — Caryving Rd",  "cam": "Cam C1 — Caryving NB", "peak": 526},
            {"name": "Southbound — Caryving Rd",  "cam": "Cam C2 — Caryving SB", "peak": 58},
            {"name": "Eastbound — Buhangin St",   "cam": "Cam C3 — Buhangin EB", "peak": 58},
            {"name": "Westbound — Buhangin St",   "cam": "Cam C4 — Buhangin WB", "peak": 58},
        ],
    },
]


def _insert_exact_hour(db, cctv_id: int, region_id: int, hour_start: "datetime", count: int, weights: dict):
    """Insert `count` detections spread uniformly across the 60-minute window."""
    if count == 0:
        return
    detections = []
    for i in range(count):
        object_type = random_object_type(weights)
        x1, y1, x2, y2 = random_bounding_box()
        # Spread evenly + small sub-second noise so each minute gets ~count/60 rows
        offset_secs = (i / count) * 3599 + random.uniform(0, 1)
        detected_at = hour_start + timedelta(seconds=offset_secs)
        detections.append(Detection(
            cctv_id=cctv_id,
            track_id=random.randint(1, 99999),
            object_type=object_type,
            confidence=round(random.uniform(0.65, 0.99), 4),
            x1=x1, y1=y1, x2=x2, y2=y2,
            time=detected_at,
        ))
    db.add_all(detections)
    db.flush()
    links = [
        DetectionInRegion(region_id=region_id, detection_id=d.id, time=d.time)
        for d in detections
    ]
    db.add_all(links)
    db.flush()


def seed_scenarios(db, weights: dict):
    """
    Create (or reuse) two demo intersections and insert exact detection counts
    for the last 3 complete hours so the warrant model reliably produces
    'warranted' and 'borderline' classifications.

    Safe to re-run — existing detections in those hours are deleted first.
    """
    from sqlalchemy import text

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    hours_to_fill = [now - timedelta(hours=h) for h in range(1, 4)]  # last 3 complete hours

    print("Seeding scenario intersections …")
    print()

    for spec in SCENARIO_INTERSECTIONS:
        # Create or reuse intersection
        existing = db.query(Intersection).filter_by(name=spec["name"]).first()
        if existing:
            intersection = existing
            print(f"  [reuse] '{spec['name']}' id={intersection.id}")
        else:
            intersection = Intersection(
                name=spec["name"],
                latitude=spec["latitude"],
                longitude=spec["longitude"],
            )
            db.add(intersection)
            db.flush()
            seed_tod_chunks(db, intersection.id)
            print(f"  [new]   '{spec['name']}' id={intersection.id}")

        for s in spec["streets"]:
            # Reuse or create street / CCTV / region
            street = db.query(Street).filter_by(
                intersection_id=intersection.id, name=s["name"]
            ).first()
            if not street:
                street = Street(intersection_id=intersection.id, name=s["name"])
                db.add(street)
                db.flush()

            cctv = db.query(CCTV).filter_by(
                intersection_id=intersection.id, name=s["cam"]
            ).first()
            if not cctv:
                cctv = CCTV(
                    intersection_id=intersection.id,
                    name=s["cam"],
                    rtsp_url=f"rtsp://{MEDIAMTX_HOST}:8554/scenario",
                    status="offline",
                )
                db.add(cctv)
                db.flush()

            region = db.query(Region).filter_by(cctv_id=cctv.id, street_id=street.id).first()
            if not region:
                region = Region(cctv_id=cctv.id, street_id=street.id)
                db.add(region)
                db.flush()
                for x, y in [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]:
                    db.add(RegionPoint(region_id=region.id, x=x, y=y))
                db.flush()

            # Delete any existing detections in the target hours, then re-insert exactly
            for h_start in hours_to_fill:
                h_end = h_start + timedelta(hours=1)
                db.execute(text(
                    "DELETE FROM detections WHERE cctv_id = :cid AND time >= :s AND time < :e"
                ), {"cid": cctv.id, "s": h_start, "e": h_end})
                db.flush()
                _insert_exact_hour(db, cctv.id, region.id, h_start, s["peak"], weights)

            print(f"    {s['name']:<35} {s['peak']:>4} det/hr × {len(hours_to_fill)} hrs")

        db.commit()
        print(f"  → expected classification: {spec['expected'].upper()}")
        print()

    print("Done. Wait ~60 s for the TimescaleDB aggregate to refresh, then run")
    print("'Generate all' on the Recommendations page to see results.")
    print()


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------

def list_data(db):
    from sqlalchemy import text

    intersections = db.query(Intersection).all()
    if not intersections:
        print("No data found. Run --seed first.")
        return

    for i in intersections:
        print(f"\nIntersection id={i.id} '{i.name}' ({i.latitude}, {i.longitude})")
        for cctv in i.cctvs:
            det_count = db.execute(
                text("SELECT COUNT(*) FROM detections WHERE cctv_id = :id"),
                {"id": cctv.id}
            ).scalar()
            print(f"  CCTV id={cctv.id} '{cctv.name}' status={cctv.status} "
                  f"detections={det_count:,}")
            for region in cctv.regions:
                print(f"    Region id={region.id} street='{region.street.name}' "
                      f"points={len(region.region_points)}")

    total_det = db.execute(text("SELECT COUNT(*) FROM detections")).scalar()
    total_agg = db.execute(text("SELECT COUNT(*) FROM aggregation_summaries")).scalar()
    print(f"\nTotals: {total_det:,} detections · {total_agg:,} aggregation buckets")

    recs = db.execute(text(
        "SELECT COUNT(*) FROM recommendations WHERE recommended = TRUE"
    )).scalar()
    print(f"Recommendations: {recs} intersections warranted")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Fake detection data tool")

    parser.add_argument("--seed",      action="store_true",
                        help="Seed intersections, streets, CCTVs, regions (idempotent)")
    parser.add_argument("--fill", "--fill-all", action="store_true",
                        help="Bulk-fill all cameras/regions with realistic traffic data")
    parser.add_argument("--full",      action="store_true",
                        help="--seed then --fill (recommended for a clean DB)")
    parser.add_argument("--scenarios", action="store_true",
                        help="Seed 'Visayan Ave' (warranted) + 'Caryving Rd' (borderline) demo intersections")
    parser.add_argument("--list",      action="store_true",
                        help="List existing data and counts")

    parser.add_argument("--days",      type=int,   default=14,
                        help="Days of history to generate with --fill (default: 14)")

    # Legacy single-camera mode
    parser.add_argument("--cctv-id",   type=int,   default=None)
    parser.add_argument("--region-id", type=int,   default=None)
    parser.add_argument("--count",     type=int,   default=500,
                        help="Number of detections (legacy --cctv-id mode)")
    parser.add_argument("--hours",     type=float, default=2.0,
                        help="Time range in hours (legacy --cctv-id mode)")
    parser.add_argument("--weights",   type=str,   default=None,
                        help="Object type weights e.g. tricycle=0.35,motorcycle=0.30,…")

    args = parser.parse_args()

    weights = parse_weights(args.weights) if args.weights else DEFAULT_WEIGHTS

    db = SessionLocal()
    try:
        if args.full:
            seed_base_data(db)
            fill_all(db, args.days, weights)
            return

        if args.seed:
            seed_base_data(db)
            return

        if args.scenarios:
            seed_scenarios(db, weights)
            return

        if args.fill:
            fill_all(db, args.days, weights)
            return

        if args.list:
            list_data(db)
            return

        # Legacy single-camera mode
        if not args.cctv_id or not args.region_id:
            print("Error: provide --cctv-id and --region-id, or use --seed / --fill / --full")
            sys.exit(1)

        print(f"Inserting {args.count} detections over {args.hours} hours …")
        print(f"  CCTV:    {args.cctv_id}")
        print(f"  Region:  {args.region_id}")
        print(f"  Weights: {weights}")
        print()

        inserted = insert_detections(
            db, args.cctv_id, args.region_id, args.count, args.hours, weights
        )
        print(f"Done. Inserted {inserted} detections.")
        print()
        print("Wait ~1 minute for aggregation_summaries to refresh, then check:")
        print("  SELECT * FROM aggregation_summaries ORDER BY window_start DESC LIMIT 20;")

    finally:
        db.close()


if __name__ == "__main__":
    main()
