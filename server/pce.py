"""PCE (Passenger Car Equivalent) resolution for Webster's formula.

Three-tier priority (highest first):
  Tier 3 — admin override (pce_overrides table)
  Tier 2 — auto-calibrated from 7-day detection data (pce_calibrated_values table)
  Tier 1 — DPWH defaults (hardcoded below)
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy.orm import Session
from sqlalchemy import text

from common.models import PceOverride, PceCalibratedValue

# Tier 1 — PCE defaults for Philippine mixed-traffic conditions.
#
# Sources (in order of authority):
#   [1] DPWH Road Safety Design Manual, 2nd ed. (2012), Appendix A —
#       cites motorcycle PCE of 0.33 for urban arterials with lane-filtering.
#   [2] JICA / NEDA Metro Manila Urban Transport Integration Study (MMUTIS, 1999),
#       Vol. 3 Annex — measured fleet PCE: motorcycle 0.33, jeepney 1.5, bus 2.5.
#   [3] HCM 6th Edition (2016), Exhibit 26-9 — baseline PCE table; PH practice
#       scales motorcycle downward from the US value (0.5) to 0.33 to reflect
#       lane-filtering behaviour not captured in the US model.
#
# Pedicab and tricycle are treated as jeepney-equivalent (1.5) due to similar
# swept-path and acceleration characteristics; no PH-specific citation exists —
# these are calibratable engineering defaults and should be overridden per
# intersection once 7-day observed data is available.
DPWH_DEFAULTS: dict[str, float] = {
    "motorcycle": 0.33,  # [1][2][3]
    "pedicab":    1.50,  # engineering estimate — calibrate after 7-day observation
    "tricycle":   1.50,  # engineering estimate — calibrate after 7-day observation
    "bicycle":    0.50,  # HCM 6th ed. Exhibit 26-9
    "car":        1.00,  # definition (reference vehicle)
    "jeepney":    1.50,  # [2]
    "bus":        2.50,  # [2]
    "truck":      2.50,  # [2]
}

# Expected share of each vehicle type in an average Tagum intersection.
# Used by the calibration algorithm as the baseline distribution.
_TYPICAL_SHARE: dict[str, float] = {
    "motorcycle": 0.50,
    "pedicab":    0.10,
    "tricycle":   0.05,
    "bicycle":    0.03,
    "car":        0.20,
    "jeepney":    0.05,
    "bus":        0.04,
    "truck":      0.03,
}

Tier = Literal["default", "calibrated", "override"]


def resolve_pce(db: Session, intersection_id: int) -> dict[str, dict]:
    """Return resolved PCE for every known vehicle type at this intersection.

    Each entry: {"pce": float, "tier": "default" | "calibrated" | "override"}
    Priority: override > calibrated > DPWH default.
    """
    overrides = {
        r.vehicle_type: r.pce_value
        for r in db.query(PceOverride).filter_by(intersection_id=intersection_id).all()
    }
    calibrated = {
        r.vehicle_type: r.pce_value
        for r in db.query(PceCalibratedValue).filter_by(intersection_id=intersection_id).all()
    }

    result: dict[str, dict] = {}
    for vtype, default in DPWH_DEFAULTS.items():
        if vtype in overrides:
            result[vtype] = {"pce": overrides[vtype], "tier": "override"}
        elif vtype in calibrated:
            result[vtype] = {"pce": calibrated[vtype], "tier": "calibrated"}
        else:
            result[vtype] = {"pce": default, "tier": "default"}

    # Include any extra overrides for non-standard types the admin added
    for vtype, val in overrides.items():
        if vtype not in result:
            result[vtype] = {"pce": val, "tier": "override"}

    return result


def calibrate_pce(db: Session, intersection_id: int) -> dict[str, float]:
    """Compute calibrated PCE from 7-day aggregation_summaries and persist.

    Returns the newly calibrated values keyed by vehicle_type.
    Algorithm: scale each DPWH default proportionally to how much the
    observed vehicle mix at this intersection deviates from the typical
    distribution — clamped to ±25 % of the DPWH baseline.
    """
    since = datetime.now(tz=timezone.utc) - timedelta(days=7)
    rows = db.execute(
        text("""
            SELECT object_type, SUM(count)::int AS total
            FROM aggregation_summaries
            WHERE intersection_id = :iid
              AND window_start >= :since
              AND object_type NOT IN ('pedestrian', 'person')
            GROUP BY object_type
        """),
        {"iid": intersection_id, "since": since},
    ).fetchall()

    if not rows:
        return {}

    observed: dict[str, int] = {r.object_type: r.total for r in rows}
    grand_total = sum(observed.values())

    calibrated: dict[str, float] = {}
    for vtype, default_pce in DPWH_DEFAULTS.items():
        if vtype not in observed or grand_total == 0:
            continue
        observed_share = observed[vtype] / grand_total
        typical_share  = _TYPICAL_SHARE.get(vtype, 0.05)
        if typical_share == 0:
            continue
        # Scale factor: >1 if this vehicle type is more prevalent than typical
        scale = observed_share / typical_share
        scale = max(0.75, min(1.25, scale))   # clamp to ±25%
        calibrated[vtype] = round(default_pce * scale, 4)

    now = datetime.now(tz=timezone.utc)
    for vtype, pce_val in calibrated.items():
        existing = (
            db.query(PceCalibratedValue)
            .filter_by(intersection_id=intersection_id, vehicle_type=vtype)
            .first()
        )
        if existing:
            existing.pce_value    = pce_val
            existing.calibrated_at = now
        else:
            db.add(PceCalibratedValue(
                intersection_id=intersection_id,
                vehicle_type=vtype,
                pce_value=pce_val,
                calibrated_at=now,
            ))

    db.commit()
    return calibrated
