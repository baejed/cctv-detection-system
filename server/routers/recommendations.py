# server/routers/recommendations.py
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from common.database import SessionLocal, get_db
from common import models
from server.utils import get_current_user
from sqlalchemy.orm import Session
from sqlalchemy import text
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional
from pydantic import BaseModel

router = APIRouter(prefix="/recommendations", tags=["Recommendations"])

# MUTCD simplified thresholds (urban, 2-lane)
# Warrant 1: 8-hour vehicular volume -major ≥500 veh/hr OR minor ≥150 veh/hr for 8 hrs
# Warrant 2: 4-hour vehicular volume -same thresholds but only 4 hrs needed
# Warrant 4: pedestrian volume -≥100 pedestrians/hr for 4 hrs

WARRANT_1_VEHICLE_THRESHOLD = 300   # total vehicles per hour at the intersection
WARRANT_1_HOURS_NEEDED = 8

WARRANT_2_VEHICLE_THRESHOLD = 300
WARRANT_2_HOURS_NEEDED = 4

WARRANT_4_PED_THRESHOLD = 50        # pedestrians per hour
WARRANT_4_HOURS_NEEDED = 4

PEDESTRIAN_TYPES = {"pedestrian", "person"}

LOOKBACK_DAYS = 7


class RecommendationResponse(BaseModel):
    id: int
    intersection_id: int
    intersection_name: str
    warrant_1_met: bool
    warrant_1_confidence: float
    warrant_2_met: bool
    warrant_2_confidence: float
    warrant_4_met: bool
    warrant_4_confidence: float
    recommended: bool
    notes: Optional[str]
    generated_at: str

    class Config:
        from_attributes = True


def _compute_features_from_rows(rows) -> dict[str, float]:
    """Pure function: from one hour of aggregation rows, compute the 5 features.

    Each row must have attributes: street_id, object_type, window_start, count.

    Returns a dict with major_volume, minor_volume, peds, vpm, phf.
    """
    # Per-street vehicle totals (excludes pedestrians) — used to pick major street
    street_veh: dict[int, int] = defaultdict(int)
    # Pedestrian total across all streets / directions
    peds_total = 0
    # Per-(street, minute) vehicle counts — for vpm and phf on the major street
    per_minute: dict[tuple[int, int], int] = defaultdict(int)

    for r in rows:
        if r.object_type in PEDESTRIAN_TYPES:
            peds_total += r.count
            continue
        street_veh[r.street_id] += r.count
        per_minute[(r.street_id, r.window_start.minute)] += r.count

    if not street_veh:
        return {
            "major_volume": 0,
            "minor_volume": 0,
            "peds": peds_total,
            "vpm": 0,
            "phf": 1.0,
        }

    major_id = max(street_veh, key=street_veh.get)
    major_volume = street_veh[major_id]
    minor_volume = sum(v for sid, v in street_veh.items() if sid != major_id)

    # vpm = max per-minute total for the major street
    major_minute_counts = [c for (sid, _m), c in per_minute.items() if sid == major_id]
    vpm = max(major_minute_counts) if major_minute_counts else 0

    # phf = hour_volume / (4 * peak_15min_volume) on the major street, clamped to [0.25, 1.0]
    if major_volume == 0:
        phf = 1.0
    else:
        bucket_15: dict[int, int] = defaultdict(int)
        for (sid, minute), c in per_minute.items():
            if sid != major_id:
                continue
            bucket_15[minute // 15] += c
        peak_15 = max(bucket_15.values()) if bucket_15 else 0
        if peak_15 == 0:
            phf = 1.0
        else:
            phf = major_volume / (4 * peak_15)
            phf = max(0.25, min(1.0, phf))

    return {
        "major_volume": int(major_volume),
        "minor_volume": int(minor_volume),
        "peds": int(peds_total),
        "vpm": int(vpm),
        "phf": float(phf),
    }


def _compute_features(intersection_id: int, db: Session) -> tuple[dict[str, float], datetime]:
    """Query aggregation_summaries for the most-recent-complete-hour and compute features.

    Returns (features_dict, hour_start_utc).
    """
    now = datetime.now(timezone.utc)
    hour_end = now.replace(minute=0, second=0, microsecond=0)
    hour_start = hour_end - timedelta(hours=1)

    rows = db.execute(text("""
        SELECT street_id, object_type, window_start, SUM(count)::int AS count
        FROM aggregation_summaries
        WHERE intersection_id = :iid
          AND window_start >= :start
          AND window_start <  :end
        GROUP BY street_id, object_type, window_start
    """), {"iid": intersection_id, "start": hour_start, "end": hour_end}).fetchall()

    return _compute_features_from_rows(rows), hour_start


def _run_warrant_analysis(intersection_id: int, db: Session) -> dict:
    """
    Run MUTCD warrant analysis for a single intersection.
    Queries aggregation_summaries for the past LOOKBACK_DAYS days.
    Returns a dict with all warrant results.
    """
    now = datetime.now(timezone.utc)
    since = now -timedelta(days=LOOKBACK_DAYS)

    rows = db.execute(text("""
        SELECT
            DATE_TRUNC('hour', window_start) AS hour_bucket,
            object_type,
            SUM(count)::int AS total
        FROM aggregation_summaries
        WHERE intersection_id = :iid
          AND window_start >= :since
        GROUP BY DATE_TRUNC('hour', window_start), object_type
        ORDER BY hour_bucket
    """), {"iid": intersection_id, "since": since}).fetchall()

    if not rows:
        return {
            "warrant_1_met": False, "warrant_1_confidence": 0.0,
            "warrant_2_met": False, "warrant_2_confidence": 0.0,
            "warrant_4_met": False, "warrant_4_confidence": 0.0,
            "recommended": False,
            "notes": f"No data found in the last {LOOKBACK_DAYS} days.",
        }

    # Aggregate by hour bucket
    vehicles_by_hour: dict[datetime, int] = defaultdict(int)
    peds_by_hour: dict[datetime, int] = defaultdict(int)

    for r in rows:
        if r.object_type in PEDESTRIAN_TYPES:
            peds_by_hour[r.hour_bucket] += r.total
        else:
            vehicles_by_hour[r.hour_bucket] += r.total

    # Count qualifying hours
    w1_qualifying = sum(1 for v in vehicles_by_hour.values() if v >= WARRANT_1_VEHICLE_THRESHOLD)
    w2_qualifying = sum(1 for v in vehicles_by_hour.values() if v >= WARRANT_2_VEHICLE_THRESHOLD)
    w4_qualifying = sum(1 for v in peds_by_hour.values() if v >= WARRANT_4_PED_THRESHOLD)

    w1_met = w1_qualifying >= WARRANT_1_HOURS_NEEDED
    w2_met = w2_qualifying >= WARRANT_2_HOURS_NEEDED
    w4_met = w4_qualifying >= WARRANT_4_HOURS_NEEDED

    w1_conf = min(1.0, w1_qualifying / WARRANT_1_HOURS_NEEDED)
    w2_conf = min(1.0, w2_qualifying / WARRANT_2_HOURS_NEEDED)
    w4_conf = min(1.0, w4_qualifying / WARRANT_4_HOURS_NEEDED)

    recommended = w1_met or w2_met or w4_met

    warrants_met = []
    if w1_met:
        warrants_met.append("Warrant 1 (8-hr vehicular volume)")
    if w2_met:
        warrants_met.append("Warrant 2 (4-hr vehicular volume)")
    if w4_met:
        warrants_met.append("Warrant 4 (pedestrian volume)")

    if recommended:
        notes = f"Signal recommended. Met: {', '.join(warrants_met)}. Analysis covers {len(vehicles_by_hour)} hour-buckets over the last {LOOKBACK_DAYS} days."
    else:
        notes = (
            f"Signal not warranted yet. "
            f"Warrant 1: {w1_qualifying}/{WARRANT_1_HOURS_NEEDED} qualifying hours "
            f"(need {WARRANT_1_VEHICLE_THRESHOLD} veh/hr). "
            f"Warrant 4: {w4_qualifying}/{WARRANT_4_HOURS_NEEDED} qualifying hours "
            f"(need {WARRANT_4_PED_THRESHOLD} ped/hr)."
        )

    return {
        "warrant_1_met": w1_met,
        "warrant_1_confidence": round(w1_conf, 3),
        "warrant_2_met": w2_met,
        "warrant_2_confidence": round(w2_conf, 3),
        "warrant_4_met": w4_met,
        "warrant_4_confidence": round(w4_conf, 3),
        "recommended": recommended,
        "notes": notes,
    }


@router.get("/", response_model=list[RecommendationResponse])
def list_recommendations(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """List all recommendations joined with intersection name."""
    rows = db.execute(text("""
        SELECT
            r.id, r.intersection_id, i.name AS intersection_name,
            r.warrant_1_met, r.warrant_1_confidence,
            r.warrant_2_met, r.warrant_2_confidence,
            r.warrant_4_met, r.warrant_4_confidence,
            r.recommended, r.notes, r.generated_at
        FROM recommendations r
        JOIN intersections i ON i.id = r.intersection_id
        ORDER BY r.generated_at DESC
    """)).fetchall()

    return [
        {
            "id": r.id,
            "intersection_id": r.intersection_id,
            "intersection_name": r.intersection_name,
            "warrant_1_met": r.warrant_1_met,
            "warrant_1_confidence": r.warrant_1_confidence,
            "warrant_2_met": r.warrant_2_met,
            "warrant_2_confidence": r.warrant_2_confidence,
            "warrant_4_met": r.warrant_4_met,
            "warrant_4_confidence": r.warrant_4_confidence,
            "recommended": r.recommended,
            "notes": r.notes,
            "generated_at": r.generated_at.isoformat(),
        }
        for r in rows
    ]


@router.post("/generate/{intersection_id}", response_model=RecommendationResponse)
def generate_recommendation(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis for one intersection and upsert the result."""
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    analysis = _run_warrant_analysis(intersection_id, db)

    # Upsert: delete old, insert new
    existing = (
        db.query(models.Recommendation)
        .filter(models.Recommendation.intersection_id == intersection_id)
        .first()
    )
    if existing:
        db.delete(existing)
        db.flush()

    rec = models.Recommendation(
        intersection_id=intersection_id,
        **analysis,
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)

    return {
        "id": rec.id,
        "intersection_id": rec.intersection_id,
        "intersection_name": intersection.name,
        "warrant_1_met": rec.warrant_1_met,
        "warrant_1_confidence": rec.warrant_1_confidence,
        "warrant_2_met": rec.warrant_2_met,
        "warrant_2_confidence": rec.warrant_2_confidence,
        "warrant_4_met": rec.warrant_4_met,
        "warrant_4_confidence": rec.warrant_4_confidence,
        "recommended": rec.recommended,
        "notes": rec.notes,
        "generated_at": rec.generated_at.isoformat(),
    }


@router.post("/generate-all", response_model=list[RecommendationResponse])
def generate_all_recommendations(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis for every intersection."""
    intersections = db.query(models.Intersection).all()
    results = []

    for intersection in intersections:
        analysis = _run_warrant_analysis(intersection.id, db)

        existing = (
            db.query(models.Recommendation)
            .filter(models.Recommendation.intersection_id == intersection.id)
            .first()
        )
        if existing:
            db.delete(existing)
            db.flush()

        rec = models.Recommendation(intersection_id=intersection.id, **analysis)
        db.add(rec)
        db.flush()
        db.refresh(rec)

        results.append({
            "id": rec.id,
            "intersection_id": rec.intersection_id,
            "intersection_name": intersection.name,
            "warrant_1_met": rec.warrant_1_met,
            "warrant_1_confidence": rec.warrant_1_confidence,
            "warrant_2_met": rec.warrant_2_met,
            "warrant_2_confidence": rec.warrant_2_confidence,
            "warrant_4_met": rec.warrant_4_met,
            "warrant_4_confidence": rec.warrant_4_confidence,
            "recommended": rec.recommended,
            "notes": rec.notes,
            "generated_at": rec.generated_at.isoformat(),
        })

    db.commit()
    return results


class NotesUpdate(BaseModel):
    notes: Optional[str]


@router.patch("/{rec_id}/notes", response_model=RecommendationResponse)
def update_notes(
    rec_id: int,
    body: NotesUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Update the engineer notes on a recommendation."""
    rec = db.get(models.Recommendation, rec_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Recommendation not found")

    intersection = db.get(models.Intersection, rec.intersection_id)
    rec.notes = body.notes
    db.commit()
    db.refresh(rec)

    return {
        "id": rec.id,
        "intersection_id": rec.intersection_id,
        "intersection_name": intersection.name if intersection else "",
        "warrant_1_met": rec.warrant_1_met,
        "warrant_1_confidence": rec.warrant_1_confidence,
        "warrant_2_met": rec.warrant_2_met,
        "warrant_2_confidence": rec.warrant_2_confidence,
        "warrant_4_met": rec.warrant_4_met,
        "warrant_4_confidence": rec.warrant_4_confidence,
        "recommended": rec.recommended,
        "notes": rec.notes,
        "generated_at": rec.generated_at.isoformat(),
    }
