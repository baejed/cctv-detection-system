# server/routers/recommendations.py
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request
from common.database import SessionLocal, get_db
from common import models
from server.utils import get_current_user
from sqlalchemy.orm import Session
from sqlalchemy import text
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional
from pydantic import BaseModel

router = APIRouter(prefix="/recommendations", tags=["Recommendations"])

PEDESTRIAN_TYPES = {"pedestrian", "person"}


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


def _analyze(
    intersection_id: int,
    artifacts,
    db: Session,
) -> dict:
    """Compute features for the most recent hour, run the model, format result.

    Returns a dict with all the columns of the Recommendation model.
    """
    from server.ml.inference import predict_warrants  # local import keeps top of file clean

    features, hour_start = _compute_features(intersection_id, db)

    if features["major_volume"] == 0 and features["minor_volume"] == 0 and features["peds"] == 0:
        return {
            "warrant_1_met": False, "warrant_1_confidence": 0.0,
            "warrant_2_met": False, "warrant_2_confidence": 0.0,
            "warrant_4_met": False, "warrant_4_confidence": 0.0,
            "recommended":   False,
            "notes": f"No data for hour starting {hour_start.isoformat()}.",
        }

    probs = predict_warrants(artifacts, features)
    w1, w2, w4, rec = probs["w1"], probs["w2"], probs["w4"], probs["recommended"]

    notes = (
        f"Hour starting {hour_start.isoformat()}. "
        f"Major: {features['major_volume']} veh/hr, "
        f"Minor: {features['minor_volume']} veh/hr, "
        f"Peds: {features['peds']}/hr, "
        f"VPM: {features['vpm']}, "
        f"PHF: {features['phf']:.2f}. "
        f"Probabilities — W1: {w1:.2f}, W2: {w2:.2f}, W4: {w4:.2f}."
    )

    return {
        "warrant_1_met":        w1 >= 0.5,
        "warrant_1_confidence": round(float(w1), 4),
        "warrant_2_met":        w2 >= 0.5,
        "warrant_2_confidence": round(float(w2), 4),
        "warrant_4_met":        w4 >= 0.5,
        "warrant_4_confidence": round(float(w4), 4),
        "recommended":          rec >= 0.5,
        "notes":                notes,
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
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis for one intersection and upsert the result."""
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    analysis = _analyze(intersection_id, request.app.state.warrant_artifacts, db)

    existing = (
        db.query(models.Recommendation)
        .filter(models.Recommendation.intersection_id == intersection_id)
        .first()
    )
    if existing:
        db.delete(existing)
        db.flush()

    rec = models.Recommendation(intersection_id=intersection_id, **analysis)
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
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis for every intersection."""
    intersections = db.query(models.Intersection).all()
    results = []

    artifacts = request.app.state.warrant_artifacts

    for intersection in intersections:
        analysis = _analyze(intersection.id, artifacts, db)

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
