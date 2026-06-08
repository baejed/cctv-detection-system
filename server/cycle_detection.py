"""Infer existing signal cycle length from camera aggregation data.

Method
------
Signal cycles create a periodic pattern in minute-level vehicle counts:
green phases produce discharge surges; red phases suppress departures.
Two statistical measures detect this:

  Dispersion index (var/mean)
    Poisson (unsignalized) arrivals give var ≈ mean (index ≈ 1).
    Signalized batch releases overdisperse the series (index >> 1).

  Autocorrelation at lag k minutes
    A cycle of length C seconds repeats exactly every LCM(60, C) seconds.
    The lag at which that LCM equals k*60 s is the detectable lag:
      60 s cycle  → lag 1 (LCM=60 s)
      120 s cycle → lag 2 (LCM=120 s)
      90 s cycle  → lag 3 (LCM=180 s)
      80 s cycle  → lag 4 (LCM=240 s)
      75 s cycle  → lag 5 (LCM=300 s)

Limitation: cameras observing arrivals (not stop-line departures) will
show weak periodicity.  Low-confidence results should not be saved without
controller verification.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session
from sqlalchemy import text

# lag (minutes) → most likely cycle (seconds) for PH signalized intersections.
#
# The minute-series period equals LCM(60, C) / 60 for a cycle of C seconds;
# for equal-split cycles (green = red) this doubles (first *positive* peak is
# at 2 × LCM / 60 because lag-1 is the anti-phase / negative peak):
#   C=60 s  → LCM=60 s=1 min, but [H,L] series has pos peak at lag 2 (same as C=120 s)
#   C=120 s → LCM=120 s=2 min, first positive peak at lag 2
#   C=90 s  → LCM=180 s=3 min, first positive peak at lag 3
#   C=80 s  → LCM=240 s=4 min, first positive peak at lag 4
#   C=75 s  → LCM=300 s=5 min, first positive peak at lag 5
_LAG_TO_CYCLE: dict[int, int] = {1: 60, 2: 120, 3: 90, 4: 80, 5: 75}

_LOOKBACK_HOURS = 72


def _pearson_r(x: list[float], y: list[float]) -> float:
    n = len(x)
    if n < 2:
        return 0.0
    mx = sum(x) / n
    my = sum(y) / n
    num   = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sx    = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy    = math.sqrt(sum((b - my) ** 2 for b in y))
    if sx == 0 or sy == 0:
        return 0.0
    return num / (sx * sy)


def estimate_signal_timing(db: Session, intersection_id: int) -> dict:
    """Return cycle-length estimate inferred from camera count patterns.

    Fields in the returned dict:
      estimated_cycle_s  – int or None
      confidence         – 'low' | 'medium' | 'high'
      note               – human-readable explanation
      dispersion_index   – float (variance/mean of raw counts)
      best_lag_min       – int (lag that maximised autocorrelation)
      best_autocorr      – float
    """
    since = datetime.now(tz=timezone.utc) - timedelta(hours=_LOOKBACK_HOURS)

    rows = db.execute(text("""
        SELECT street_id,
               date_trunc('minute', window_start) AS minute,
               SUM(count)                          AS count
          FROM aggregation_summaries
         WHERE intersection_id = :iid
           AND window_start    >= :since
           AND object_type NOT IN ('pedestrian', 'person')
           AND street_id IS NOT NULL
         GROUP BY street_id, date_trunc('minute', window_start)
         ORDER BY street_id, minute
    """), {"iid": intersection_id, "since": since}).fetchall()

    if not rows:
        return _no_data("No detection data in the last 72 hours.")

    # Pick the busiest street (most representative of signal behaviour)
    street_total: dict[int, float] = defaultdict(float)
    for r in rows:
        street_total[r.street_id] += float(r.count)

    busiest     = max(street_total, key=street_total.get)
    series_raw  = [float(r.count) for r in rows if r.street_id == busiest]
    n           = len(series_raw)

    if n < 30:
        return _no_data(
            f"Only {n} minute-windows available — need at least 30 for cycle detection."
        )

    mean = sum(series_raw) / n
    if mean == 0:
        return _no_data("No vehicle detections recorded in the selected window.")

    # Dispersion index (overdispersion vs Poisson)
    var_raw       = sum((v - mean) ** 2 for v in series_raw) / max(n - 1, 1)
    dispersion    = var_raw / mean

    # Detrend: subtract per-60-minute-bin mean to isolate cycle signal from
    # hour-of-day demand variation
    bin_sums: dict[int, float] = defaultdict(float)
    bin_cnt:  dict[int, int]   = defaultdict(int)
    for i, v in enumerate(series_raw):
        b = i // 60
        bin_sums[b] += v
        bin_cnt[b]  += 1
    bin_means = {b: bin_sums[b] / bin_cnt[b] for b in bin_sums}
    series = [series_raw[i] - bin_means[i // 60] for i in range(n)]

    # Autocorrelation at lags 1–5 minutes
    autocorr: dict[int, float] = {}
    for lag in range(1, 6):
        if lag >= n:
            autocorr[lag] = 0.0
        else:
            autocorr[lag] = _pearson_r(series[:-lag], series[lag:])

    best_lag = max(autocorr, key=autocorr.get)
    best_r   = autocorr[best_lag]

    estimated_cycle_s: Optional[int] = _LAG_TO_CYCLE.get(best_lag, best_lag * 60)

    if best_r < 0.15 or dispersion < 1.5:
        return {
            "estimated_cycle_s": None,
            "confidence":        "low",
            "note": (
                f"No clear cycle pattern detected (r={best_r:.2f}, "
                f"dispersion={dispersion:.1f}). "
                "The camera may be observing arriving vehicles rather than "
                "stop-line departures, or the intersection may be unsignalized. "
                "Read the cycle length from the controller box directly."
            ),
            "dispersion_index": round(dispersion, 2),
            "best_lag_min":     best_lag,
            "best_autocorr":    round(best_r, 3),
        }

    if best_r < 0.30 or dispersion < 3.0:
        confidence = "medium"
        note = (
            f"Moderate periodicity at ~{estimated_cycle_s} s "
            f"(r={best_r:.2f}, dispersion={dispersion:.1f}). "
            "Treat as a rough starting estimate — verify against the "
            "controller box before saving."
        )
    else:
        confidence = "high"
        note = (
            f"Strong periodic pattern at ~{estimated_cycle_s} s "
            f"(r={best_r:.2f}, dispersion={dispersion:.1f}). "
            "Likely reflects the existing signal cycle. "
            "Verify against the controller before using."
        )

    return {
        "estimated_cycle_s": estimated_cycle_s,
        "confidence":        confidence,
        "note":              note,
        "dispersion_index":  round(dispersion, 2),
        "best_lag_min":      best_lag,
        "best_autocorr":     round(best_r, 3),
    }


def _no_data(reason: str) -> dict:
    return {
        "estimated_cycle_s": None,
        "confidence":        "low",
        "note":              reason,
        "dispersion_index":  None,
        "best_lag_min":      None,
        "best_autocorr":     None,
    }
