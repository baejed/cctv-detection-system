# server/routers/recommendations.py
import logging
import time
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request
from common.database import SessionLocal, get_db
from common import models
from server.improvement import evaluate as evaluate_improvement
from server.utils import get_current_user
from server.rate_limit import limiter
from server.warrant_rules import IntersectionMeta
from server.intervention_rules import assign_intervention_label
from sqlalchemy.orm import Session
from sqlalchemy import text
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger("recommendations")

router = APIRouter(prefix="/recommendations", tags=["Recommendations"])

PEDESTRIAN_TYPES = {"pedestrian", "person"}

# Temporal CNN input convention (mirrors server.ml.synthetic_traffic constants).
_CNN_N_SLOTS = 96
_CNN_N_VEHICLE_CHANNELS = 4
_CNN_PED_CHANNEL_INDEX = 4
_CNN_N_CHANNELS = 5
_CNN_SLOT_MINUTES = 15


class InterventionInfo(BaseModel):
    """The new T16 bundle field: which structural intervention the CNN picks."""
    name: str = Field(alias="class")
    confidence: float

    model_config = ConfigDict(populate_by_name=True)


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
    recommended_confidence: Optional[float] = None
    major_volume: Optional[int] = None
    minor_volume: Optional[int] = None
    peds: Optional[int] = None
    vpm: Optional[int] = None
    phf: Optional[float] = None
    hour_start: Optional[str] = None
    data_age_hours: Optional[float] = None
    notes: Optional[str]
    generated_at: str
    timing_cycle: Optional[int] = None
    timing_chunk: Optional[str] = None
    w_local_1_met: Optional[bool] = None
    w_local_1_confidence: Optional[float] = None
    w_local_2_met: Optional[bool] = None
    w_local_2_confidence: Optional[float] = None
    w_local_3_met: Optional[bool] = None
    w_local_3_confidence: Optional[float] = None
    intervention: Optional[InterventionInfo] = None
    proposal_is_no_op: bool = False

    model_config = ConfigDict(from_attributes=True)


def _compute_features_from_rows(rows) -> dict[str, float]:
    """Pure function: from one hour of aggregation rows, compute the 5 features.

    Each row must have attributes: street_id, object_type, window_start, count.

    Returns a dict with major_volume, minor_volume, peds, vpm, phf.
    """
    # Per-street vehicle totals (excludes pedestrians) - used to pick major street
    street_veh: dict[int, int] = defaultdict(int)
    # Pedestrian total across all streets / directions
    peds_total = 0
    # Per-(street, minute) vehicle counts - for vpm and phf on the major street
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
    """Query the most-recent-complete-hour and compute features.

    Prefers `aggregation_summaries` (the continuous aggregate) for speed, but
    falls back to the live `detection_street_view` when the aggregate is empty
    for the requested window. Without this fallback, the card shows "1230
    detected today" from the live SSE stream while the warrant badge shows
    "No data" because the TimescaleDB continuous-aggregate job hasn't caught
    up to the latest closed hour yet.

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

    if not rows:
        rows = db.execute(text("""
            SELECT street_id,
                   object_type,
                   DATE_TRUNC('minute', time) AS window_start,
                   COUNT(*)::int              AS count
              FROM detection_street_view
             WHERE intersection_id = :iid
               AND time >= :start
               AND time <  :end
             GROUP BY street_id, object_type, DATE_TRUNC('minute', time)
        """), {"iid": intersection_id, "start": hour_start, "end": hour_end}).fetchall()

    return _compute_features_from_rows(rows), hour_start


def _build_flow_matrix(intersection_id: int, db: Session) -> "np.ndarray":
    """Build a (5, 96) flow matrix for the trailing 24 hours, matching the CNN
    input convention (4 per-approach vehicle channels + 1 pedestrian channel,
    96 fifteen-minute slots).

    Streams are mapped to channels deterministically by ascending street_id,
    capped at four streets. The fifth channel sums pedestrian counts across
    all streets. Prefers `aggregation_summaries` for speed, falls back to the
    live `detection_street_view` when the continuous aggregate is empty so a
    just-rebooted system can still drive inference.
    """
    import numpy as np

    now = datetime.now(timezone.utc)
    window_end = now.replace(minute=0, second=0, microsecond=0)
    window_start = window_end - timedelta(hours=24)

    rows = db.execute(text("""
        SELECT street_id, object_type, window_start, SUM(count)::int AS count
        FROM aggregation_summaries
        WHERE intersection_id = :iid
          AND window_start >= :start
          AND window_start <  :end
        GROUP BY street_id, object_type, window_start
    """), {"iid": intersection_id, "start": window_start, "end": window_end}).fetchall()

    if not rows:
        rows = db.execute(text("""
            SELECT street_id,
                   object_type,
                   DATE_TRUNC('minute', time) AS window_start,
                   COUNT(*)::int              AS count
              FROM detection_street_view
             WHERE intersection_id = :iid
               AND time >= :start
               AND time <  :end
             GROUP BY street_id, object_type, DATE_TRUNC('minute', time)
        """), {"iid": intersection_id, "start": window_start, "end": window_end}).fetchall()

    veh_street_ids = sorted({r.street_id for r in rows if r.object_type not in PEDESTRIAN_TYPES})
    street_to_channel = {sid: idx for idx, sid in enumerate(veh_street_ids[:_CNN_N_VEHICLE_CHANNELS])}

    flow = np.zeros((_CNN_N_CHANNELS, _CNN_N_SLOTS), dtype=np.float32)
    for r in rows:
        wstart = r.window_start if r.window_start.tzinfo else r.window_start.replace(tzinfo=timezone.utc)
        slot_minutes = int((wstart - window_start).total_seconds() // 60)
        slot_idx = max(0, min(_CNN_N_SLOTS - 1, slot_minutes // _CNN_SLOT_MINUTES))
        if r.object_type in PEDESTRIAN_TYPES:
            flow[_CNN_PED_CHANNEL_INDEX, slot_idx] += float(r.count)
        else:
            ch = street_to_channel.get(r.street_id)
            if ch is not None:
                flow[ch, slot_idx] += float(r.count)
    return flow


def _intersection_to_meta(intersection: models.Intersection) -> IntersectionMeta:
    """Project an Intersection row into the IntersectionMeta dataclass the CNN
    expects. Lane count and posted speed are not yet stored on the schema; fall
    back to the Tagum-realistic defaults the PRD calls out (major_lanes=2,
    minor_lanes=2, posted_speed_kph=40) until they are surfaced through the
    onboarding flow. n_approaches is clipped to the {3, 4} range the training
    distribution covers.
    """
    status = (intersection.signal_status or "unsignalized").lower()
    is_signalized = status in ("fixed_time", "actuated")
    streets = getattr(intersection, "streets", None) or []
    n_approaches = max(3, min(4, len(streets) or 4))
    return IntersectionMeta(
        major_lanes=2,
        minor_lanes=2,
        posted_speed_kph=40,
        is_signalized=is_signalized,
        n_approaches=n_approaches,
    )


def _empty_analysis(hour_start: datetime) -> dict:
    return {
        "warrant_1_met": False, "warrant_1_confidence": 0.0,
        "warrant_2_met": False, "warrant_2_confidence": 0.0,
        "warrant_4_met": False, "warrant_4_confidence": 0.0,
        "recommended":            False,
        "recommended_confidence": 0.0,
        "major_volume": 0, "minor_volume": 0, "peds": 0, "vpm": 0, "phf": 1.0,
        "hour_start": hour_start,
        "notes": None,
    }


def _analyze(
    intersection: models.Intersection,
    warrant_artifacts,
    recommender_artifacts,
    db: Session,
) -> tuple[dict, Optional[dict]]:
    """Compute the recommendation analysis for `intersection`.

    Returns ``(analysis_dict, intervention_info)``. ``analysis_dict`` is the
    flat kwargs bundle for ``models.Recommendation(...)``. ``intervention_info``
    is the additive PRD §API-contract field (``{"class", "confidence"}``) when
    the temporal CNN path ran successfully, or ``None`` when the scalar baseline
    served the request (no recommender loaded, recommender raised, or empty
    data).

    Dispatch:
      * If ``recommender_artifacts`` is loaded → temporal CNN path
        (predict_recommendations over a 24-hour flow matrix + intersection
        metadata).
      * Otherwise → scalar baseline path (predict_warrants over the 5 hand-
        engineered scalars), preserving user-story #13 rollback safety.
      * On any failure in the temporal path the function logs and falls
        through to the baseline so a transient ML issue cannot brick the
        recommendations API.
    """
    intersection_id = intersection.id

    t0 = time.perf_counter()
    features, hour_start = _compute_features(intersection_id, db)
    elapsed_feat = (time.perf_counter() - t0) * 1000

    if features["major_volume"] == 0 and features["minor_volume"] == 0 and features["peds"] == 0:
        log.info(
            "analyze intersection=%d hour=%s EMPTY_DATA (feat_ms=%.1f)",
            intersection_id, hour_start.isoformat(), elapsed_feat,
        )
        return _empty_analysis(hour_start), None

    if recommender_artifacts is not None:
        try:
            from server.ml.temporal_inference import predict_recommendations

            flow_matrix = _build_flow_matrix(intersection_id, db)
            meta = _intersection_to_meta(intersection)

            t1 = time.perf_counter()
            result = predict_recommendations(recommender_artifacts, flow_matrix, meta)
            elapsed_pred = (time.perf_counter() - t1) * 1000

            wp = result.warrant_probs
            w1, w2, w4 = wp.get("w1", 0.0), wp.get("w2", 0.0), wp.get("w4", 0.0)
            recommended = result.intervention != "timing_only"
            conf = float(result.intervention_confidence)

            log.info(
                "analyze intersection=%d hour=%s mode=cnn "
                "feat=(maj=%d min=%d ped=%d vpm=%d phf=%.2f) "
                "prob=(w1=%.2f w2=%.2f w4=%.2f) "
                "intervention=%s(conf=%.2f) "
                "(feat_ms=%.1f pred_ms=%.1f)",
                intersection_id, hour_start.isoformat(),
                features["major_volume"], features["minor_volume"], features["peds"],
                features["vpm"], features["phf"],
                w1, w2, w4,
                result.intervention, conf,
                elapsed_feat, elapsed_pred,
            )

            analysis = {
                "warrant_1_met":          w1 >= 0.5,
                "warrant_1_confidence":   round(float(w1), 4),
                "warrant_2_met":          w2 >= 0.5,
                "warrant_2_confidence":   round(float(w2), 4),
                "warrant_4_met":          w4 >= 0.5,
                "warrant_4_confidence":   round(float(w4), 4),
                "recommended":            recommended,
                "recommended_confidence": round(conf, 4),
                "major_volume":           int(features["major_volume"]),
                "minor_volume":           int(features["minor_volume"]),
                "peds":                   int(features["peds"]),
                "vpm":                    int(features["vpm"]),
                "phf":                    float(features["phf"]),
                "hour_start":             hour_start,
                "notes":                  None,
            }
            intervention_info = {
                "class": result.intervention,
                "confidence": round(conf, 4),
            }
            return analysis, intervention_info
        except Exception:
            log.exception(
                "analyze intersection=%d cnn path failed - falling back to scalar baseline",
                intersection_id,
            )

    if warrant_artifacts is None:
        raise HTTPException(status_code=503, detail="Warrant model not available")
    from server.ml.inference import predict_warrants  # local import keeps top of file clean

    t1 = time.perf_counter()
    probs = predict_warrants(warrant_artifacts, features)
    elapsed_pred = (time.perf_counter() - t1) * 1000
    w1, w2, w4, rec = probs["w1"], probs["w2"], probs["w4"], probs["recommended"]

    log.info(
        "analyze intersection=%d hour=%s mode=mlp "
        "feat=(maj=%d min=%d ped=%d vpm=%d phf=%.2f) "
        "prob=(w1=%.2f w2=%.2f w4=%.2f rec=%.2f) "
        "(feat_ms=%.1f pred_ms=%.1f)",
        intersection_id, hour_start.isoformat(),
        features["major_volume"], features["minor_volume"], features["peds"],
        features["vpm"], features["phf"],
        w1, w2, w4, rec,
        elapsed_feat, elapsed_pred,
    )

    return {
        "warrant_1_met":          w1 >= 0.5,
        "warrant_1_confidence":   round(float(w1), 4),
        "warrant_2_met":          w2 >= 0.5,
        "warrant_2_confidence":   round(float(w2), 4),
        "warrant_4_met":          w4 >= 0.5,
        "warrant_4_confidence":   round(float(w4), 4),
        "recommended":            rec >= 0.5,
        "recommended_confidence": round(float(rec), 4),
        "major_volume":           int(features["major_volume"]),
        "minor_volume":           int(features["minor_volume"]),
        "peds":                   int(features["peds"]),
        "vpm":                    int(features["vpm"]),
        "phf":                    float(features["phf"]),
        "hour_start":             hour_start,
        "notes":                  None,
    }, None


def _data_age_hours(hour_start: datetime | None) -> float | None:
    if hour_start is None:
        return None
    hs = hour_start if hour_start.tzinfo else hour_start.replace(tzinfo=timezone.utc)
    return round((datetime.now(timezone.utc) - hs).total_seconds() / 3600, 1)


def _rec_to_response(
    rec: models.Recommendation,
    intersection_name: str,
    timing_cycle: int | None = None,
    timing_chunk: str | None = None,
    intervention: Optional[dict] = None,
) -> dict:
    return {
        "id": rec.id,
        "intersection_id": rec.intersection_id,
        "intersection_name": intersection_name,
        "warrant_1_met": rec.warrant_1_met,
        "warrant_1_confidence": rec.warrant_1_confidence,
        "warrant_2_met": rec.warrant_2_met,
        "warrant_2_confidence": rec.warrant_2_confidence,
        "warrant_4_met": rec.warrant_4_met,
        "warrant_4_confidence": rec.warrant_4_confidence,
        "recommended": rec.recommended,
        "recommended_confidence": rec.recommended_confidence,
        "major_volume": rec.major_volume,
        "minor_volume": rec.minor_volume,
        "peds": rec.peds,
        "vpm": rec.vpm,
        "phf": rec.phf,
        "hour_start": rec.hour_start.isoformat() if rec.hour_start else None,
        "data_age_hours": _data_age_hours(rec.hour_start),
        "notes": rec.notes,
        "generated_at": rec.generated_at.isoformat(),
        "timing_cycle": timing_cycle,
        "timing_chunk": timing_chunk,
        "w_local_1_met": rec.w_local_1_met,
        "w_local_1_confidence": rec.w_local_1_confidence,
        "w_local_2_met": rec.w_local_2_met,
        "w_local_2_confidence": rec.w_local_2_confidence,
        "w_local_3_met": rec.w_local_3_met,
        "w_local_3_confidence": rec.w_local_3_confidence,
        "intervention": intervention,
        "proposal_is_no_op": bool(rec.proposal_is_no_op),
    }


@router.get("/", response_model=list[RecommendationResponse])
def list_recommendations(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Return the latest recommendation per intersection, with timing summary.

    The `intervention` field is computed here using `assign_intervention_label`
    so the dashboard and the detail page agree on Widen-vs-Signalize. The CNN's
    own intervention prediction is not persisted, so we fall back to the
    deterministic rules engine using the stored warrant flags + the post-Webster
    critical v/c from the latest simulation. This keeps both UIs consistent
    without requiring a schema migration.
    """
    rows = db.execute(text("""
        SELECT DISTINCT ON (r.intersection_id)
            r.id, r.intersection_id, i.name AS intersection_name,
            i.signal_status,
            r.warrant_1_met, r.warrant_1_confidence,
            r.warrant_2_met, r.warrant_2_confidence,
            r.warrant_4_met, r.warrant_4_confidence,
            r.recommended, r.recommended_confidence,
            r.major_volume, r.minor_volume, r.peds, r.vpm, r.phf,
            r.hour_start, r.notes, r.generated_at,
            tr.cycle_length AS timing_cycle,
            tr.chunk_name   AS timing_chunk,
            r.w_local_1_met, r.w_local_1_confidence,
            r.w_local_2_met, r.w_local_2_confidence,
            r.w_local_3_met, r.w_local_3_confidence,
            r.proposal_is_no_op,
            (SELECT MAX(vc_ratio_after)
               FROM simulation_results
              WHERE recommendation_id = r.id) AS max_vc_after
        FROM recommendations r
        JOIN intersections i ON i.id = r.intersection_id
        LEFT JOIN timing_recommendations tr
               ON tr.recommendation_id = r.id
              AND tr.chunk_name = 'overall'
        ORDER BY r.intersection_id, r.generated_at DESC
    """)).fetchall()

    def _intervention_for(r) -> Optional[dict]:
        is_signalized = (r.signal_status or "").lower() in ("fixed_time", "actuated")
        # Defensive: if Webster never ran for this intersection, critical_vc is
        # unknown - treat as 0 so the widening branch can't fire on missing data.
        critical_vc = float(r.max_vc_after) if r.max_vc_after is not None else 0.0
        warrant_results = {
            "w1":        (bool(r.warrant_1_met),  float(r.warrant_1_confidence  or 0)),
            "w2":        (bool(r.warrant_2_met),  float(r.warrant_2_confidence  or 0)),
            "w4":        (bool(r.warrant_4_met),  float(r.warrant_4_confidence  or 0)),
            "w_local_1": (bool(r.w_local_1_met),  float(r.w_local_1_confidence  or 0)),
            "w_local_2": (bool(r.w_local_2_met),  float(r.w_local_2_confidence  or 0)),
            "w_local_3": (bool(r.w_local_3_met),  float(r.w_local_3_confidence  or 0)),
        }
        cls = assign_intervention_label(
            critical_vc=critical_vc,
            is_signalized=is_signalized,
            warrant_results=warrant_results,
        )
        # Confidence: use the recommendation's overall confidence as a stand-in -
        # the rules engine doesn't emit one and the UI just needs a number for
        # the percentage badge.
        return {"class": cls, "confidence": float(r.recommended_confidence or 0)}

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
            "recommended_confidence": r.recommended_confidence,
            "major_volume": r.major_volume,
            "minor_volume": r.minor_volume,
            "peds": r.peds,
            "vpm": r.vpm,
            "phf": r.phf,
            "hour_start": r.hour_start.isoformat() if r.hour_start else None,
            "data_age_hours": _data_age_hours(r.hour_start),
            "notes": r.notes,
            "generated_at": r.generated_at.isoformat(),
            "timing_cycle": r.timing_cycle,
            "timing_chunk": r.timing_chunk,
            "w_local_1_met": r.w_local_1_met,
            "w_local_1_confidence": r.w_local_1_confidence,
            "w_local_2_met": r.w_local_2_met,
            "w_local_2_confidence": r.w_local_2_confidence,
            "w_local_3_met": r.w_local_3_met,
            "w_local_3_confidence": r.w_local_3_confidence,
            "proposal_is_no_op": bool(r.proposal_is_no_op),
            "intervention": _intervention_for(r),
        }
        for r in rows
    ]


_NOT_WARRANTED_NOTE = (
    "Signal not warranted by current volumes and intersection is unsignalized - "
    "no timing recommendation generated."
)
_NO_IMPROVEMENT_NOTE = (
    "Existing signal timing already meets or beats Webster's proposal at every "
    "TOD chunk - no retune recommended."
)


def _maybe_generate_timing_and_sim(
    db: Session,
    intersection: models.Intersection,
    rec: models.Recommendation,
    signal_off_chunks: set[str],
) -> tuple[list, str | None]:
    """Gate timing + simulation behind warrant + signal-status + improvement checks.

    Skips Webster entirely when the intersection is unsignalized AND not warranted
    - emitting a plan for an intersection that shouldn't have a signal misleads
    operators into thinking the system endorses signalization.

    For already-signalized intersections, runs Webster + simulation. When the
    proposal doesn't beat the existing timing on any chunk, the rows are kept
    (so the UI can render a "current vs proposed" comparison for transparency)
    but the recommendation is flagged with ``proposal_is_no_op=True`` and a note
    is written so the frontend can muted-render it instead of pitching action.
    Notes are written to rec.notes only when empty so we never clobber operator
    annotations.
    """
    from server.webster import generate_timing_for_recommendation
    from server.simulation import generate_simulation

    status = (intersection.signal_status or "unsignalized").lower()
    is_signalized = status in ("fixed_time", "actuated")

    # Case 1: unsignalized + not warranted → still run Webster + simulation as
    # informational ("what-if you signalized?"), but stamp a note so the UI
    # makes clear no signal is actually warranted.
    if not rec.recommended and not is_signalized and not rec.notes:
        rec.notes = _NOT_WARRANTED_NOTE

    timing_rows, peak_chunk = generate_timing_for_recommendation(
        db, intersection, rec.id, signal_off_chunks=signal_off_chunks
    )
    for tr in timing_rows:
        db.add(tr)
    db.flush()

    sim_rows = generate_simulation(db, intersection, rec.id, timing_rows)
    for sr in sim_rows:
        db.add(sr)
    db.flush()

    # Case 2: already signalized + Webster never beats existing → keep the rows
    # but flag the recommendation as a no-op so the UI can render them in a
    # muted/comparison mode rather than as a "recommended" plan. Dropping the
    # rows entirely (the prior behaviour) made the SignalTiming page useless
    # for operators who wanted to see *why* the system said "no change".
    if is_signalized and sim_rows:
        improvement = evaluate_improvement(sim_rows)
        if not improvement.meets_threshold:
            rec.proposal_is_no_op = True
            if not rec.notes:
                rec.notes = _NO_IMPROVEMENT_NOTE

    return timing_rows, peak_chunk


@router.post("/generate/{intersection_id}", response_model=RecommendationResponse)
def generate_recommendation(
    intersection_id: int,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis + timing for one intersection and insert new rows."""
    from server.local_warrants import evaluate_all as evaluate_local_warrants

    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    analysis, intervention = _analyze(
        intersection,
        request.app.state.warrant_artifacts,
        request.app.state.recommender_artifacts,
        db,
    )

    chunks = (
        db.query(models.TodChunk)
        .filter_by(intersection_id=intersection_id)
        .order_by(models.TodChunk.start_minutes)
        .all()
    )
    local_fields, signal_off = evaluate_local_warrants(db, intersection, chunks)
    analysis.update(local_fields)

    rec = models.Recommendation(intersection_id=intersection_id, **analysis)
    db.add(rec)
    db.flush()  # populate rec.id before using it

    timing_rows, peak_chunk = _maybe_generate_timing_and_sim(
        db, intersection, rec, set(signal_off)
    )

    db.commit()
    db.refresh(rec)

    overall = next((t for t in timing_rows if t.chunk_name == "overall"), None)
    return _rec_to_response(
        rec,
        intersection.name,
        timing_cycle=overall.cycle_length if overall else None,
        timing_chunk=peak_chunk,
        intervention=intervention,
    )


def run_generate_all(
    db: Session,
    warrant_artifacts,
    recommender_artifacts=None,
) -> list[dict]:
    """Run warrant analysis + timing + simulation for every intersection.

    Callable from the API endpoint and from the background scheduler.
    Returns a list of response dicts (same shape as RecommendationResponse).
    """
    from server.local_warrants import evaluate_all as evaluate_local_warrants

    intersections = db.query(models.Intersection).all()
    results = []

    for intersection in intersections:
        try:
            analysis, intervention = _analyze(
                intersection, warrant_artifacts, recommender_artifacts, db,
            )

            chunks = (
                db.query(models.TodChunk)
                .filter_by(intersection_id=intersection.id)
                .order_by(models.TodChunk.start_minutes)
                .all()
            )
            local_fields, signal_off = evaluate_local_warrants(db, intersection, chunks)
            analysis.update(local_fields)

            rec = models.Recommendation(intersection_id=intersection.id, **analysis)
            db.add(rec)
            db.flush()

            timing_rows, peak_chunk = _maybe_generate_timing_and_sim(
                db, intersection, rec, set(signal_off)
            )
            db.refresh(rec)

            overall = next((t for t in timing_rows if t.chunk_name == "overall"), None)
            results.append(_rec_to_response(
                rec,
                intersection.name,
                timing_cycle=overall.cycle_length if overall else None,
                timing_chunk=peak_chunk,
                intervention=intervention,
            ))
            db.commit()
        except Exception:
            log.exception("generate_all: failed for intersection %d - skipping", intersection.id)
            db.rollback()

    return results


@router.post("/generate-all", response_model=list[RecommendationResponse])
@limiter.limit("10/minute")
def generate_all_recommendations(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Run warrant analysis + timing for every intersection (on-demand)."""
    return run_generate_all(
        db,
        request.app.state.warrant_artifacts,
        request.app.state.recommender_artifacts,
    )


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

    return _rec_to_response(rec, intersection.name if intersection else "")


@router.get("/history/{intersection_id}", response_model=list[RecommendationResponse])
def list_history(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
    limit: int = 50,
):
    """Return all recommendation runs for an intersection, newest first."""
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    limit = max(1, min(limit, 200))

    rows = (
        db.query(models.Recommendation)
        .filter(models.Recommendation.intersection_id == intersection_id)
        .order_by(models.Recommendation.generated_at.desc())
        .limit(limit)
        .all()
    )
    log.info("history intersection=%d limit=%d → %d rows", intersection_id, limit, len(rows))
    return [_rec_to_response(rec, intersection.name) for rec in rows]


_DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


class DataHealthResponse(BaseModel):
    intersection_id: int
    last_detection_at: Optional[str] = None
    data_age_hours: Optional[float] = None
    camera_ok: bool
    high_volume_days: list[str]
    high_volume_days_note: Optional[str] = None


@router.get("/data-health/{intersection_id}", response_model=DataHealthResponse)
def data_health(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[models.User, Depends(get_current_user)],
):
    """Camera health check + weekly volume pattern for an intersection.

    camera_ok = True when a detection was recorded within the last 2 hours.
    high_volume_days = days of week where average daily volume exceeds 130 % of
    the weekly mean - a proxy for market-day or recurring event spikes.
    """
    intersection = db.get(models.Intersection, intersection_id)
    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    last_row = db.execute(text("""
        SELECT MAX(window_start) AS last_seen
        FROM aggregation_summaries
        WHERE intersection_id = :iid
    """), {"iid": intersection_id}).fetchone()

    last_seen: datetime | None = last_row.last_seen if last_row else None
    if last_seen and last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)

    age_hours = _data_age_hours(last_seen)
    camera_ok = age_hours is not None and age_hours <= 2.0

    # Weekly pattern: average vehicle count per calendar day, grouped by day-of-week
    dow_rows = db.execute(text("""
        SELECT EXTRACT(DOW FROM window_start)::int AS dow,
               DATE(window_start AT TIME ZONE 'UTC')  AS day,
               SUM(count)                             AS daily_total
          FROM aggregation_summaries
         WHERE intersection_id = :iid
           AND window_start >= NOW() - INTERVAL '28 days'
           AND object_type NOT IN ('pedestrian', 'person')
         GROUP BY dow, day
    """), {"iid": intersection_id}).fetchall()

    # Aggregate: per DOW → list of daily totals
    from collections import defaultdict
    dow_totals: dict[int, list[float]] = defaultdict(list)
    for r in dow_rows:
        dow_totals[r.dow].append(float(r.daily_total))

    high_volume_days: list[str] = []
    if dow_totals:
        dow_avgs = {dow: sum(vals) / len(vals) for dow, vals in dow_totals.items()}
        overall_avg = sum(dow_avgs.values()) / len(dow_avgs)
        threshold = overall_avg * 1.30
        high_volume_days = [
            _DOW_NAMES[dow]
            for dow, avg in sorted(dow_avgs.items())
            if avg >= threshold
        ]

    note = (
        f"Volume on {', '.join(high_volume_days)} is consistently ≥130% of weekly average - "
        "likely a recurring market day or school event. Webster's timing uses a 7-day rolling "
        "average and will partially reflect this; consider a dedicated TOD chunk."
        if high_volume_days else None
    )

    return DataHealthResponse(
        intersection_id=intersection_id,
        last_detection_at=last_seen.isoformat() if last_seen else None,
        data_age_hours=age_hours,
        camera_ok=camera_ok,
        high_volume_days=high_volume_days,
        high_volume_days_note=note,
    )
