"""Aggregation history query builder.

Owns the rule: for recent ranges (≤2 days at hour bucket) the live
detection_street_view is fresh enough and fast; for longer ranges the
continuous aggregate aggregation_summaries is pre-computed and much faster
to scan. Callers ask for a history window; this module picks the source.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal, Optional

Bucket = Literal["hour", "day", "week"]
Source = Literal["live_view", "continuous_aggregate"]

# Bucket value goes straight into a DATE_TRUNC literal in the SQL below, so it
# must come from this set - never accept the bucket string from a request
# without funnelling through Literal["hour","day","week"].
_TRUNC_ALLOWLIST: dict[Bucket, str] = {"hour": "hour", "day": "day", "week": "week"}

# Switch-over threshold. Anything within this window at hour granularity stays
# on the live view; longer or coarser ranges fall through to the aggregate.
_LIVE_VIEW_MAX_RANGE = timedelta(days=2)


def select_source(*, start: datetime, end: datetime, bucket: Bucket) -> Source:
    """Pick the cheaper source for this query window.

    Forced to ``continuous_aggregate`` unconditionally: when detection_street_view
    has accumulated 100k+ rows (e.g., after a seed run) the live-view path
    times out and every call from the frontend stacks another concurrent
    query, exhausting the pgbouncer pool and wedging the API. The aggregate
    is up to ~1 min stale - acceptable for every consumer that currently
    calls /aggregation/history. Args kept in the signature for callers that
    still pass them.
    """
    del start, end, bucket  # parameters retained for API compatibility
    return "continuous_aggregate"


def build_history_query(
    *,
    start: datetime,
    end: datetime,
    bucket: Bucket,
    intersection_id: Optional[int] = None,
    street_id: Optional[int] = None,
    direction: Optional[str] = None,
) -> tuple[str, dict, Source]:
    """Build the SQL + bound params for an aggregation history query.

    Returns (sql, params, source) - the chosen source is returned so callers can
    log or assert it in tests.
    """
    trunc = _TRUNC_ALLOWLIST[bucket]
    source = select_source(start=start, end=end, bucket=bucket)

    # The live view uses 'a.time'; the continuous aggregate uses 'a.window_start'.
    # Conditions are templated against the right column per source.
    if source == "live_view":
        time_col = "a.time"
        conditions = [f"{time_col} >= :start", f"{time_col} < :end"]
    else:
        time_col = "a.window_start"
        conditions = [f"{time_col} >= :start", f"{time_col} < :end"]

    params: dict = {"start": start, "end": end}

    if intersection_id is not None:
        conditions.append("a.intersection_id = :intersection_id")
        params["intersection_id"] = intersection_id
    if street_id is not None:
        conditions.append("a.street_id = :street_id")
        params["street_id"] = street_id
    if direction is not None:
        conditions.append("a.direction = :direction")
        params["direction"] = direction

    where = " AND ".join(conditions)

    if source == "live_view":
        sql = f"""
            SELECT
                a.intersection_id,
                a.intersection_name,
                a.street_id,
                a.direction,
                a.object_type,
                DATE_TRUNC('{trunc}', a.time)  AS window_start,
                COUNT(*)::int                   AS count
            FROM detection_street_view a
            WHERE {where}
            GROUP BY
                a.intersection_id, a.intersection_name, a.street_id, a.direction, a.object_type,
                DATE_TRUNC('{trunc}', a.time)
            ORDER BY
                DATE_TRUNC('{trunc}', a.time),
                a.intersection_id, a.street_id, a.direction, a.object_type
        """
    else:
        sql = f"""
            SELECT
                a.intersection_id,
                i.name          AS intersection_name,
                a.street_id,
                a.direction,
                a.object_type,
                DATE_TRUNC('{trunc}', a.window_start) AS window_start,
                SUM(a.count)::int                      AS count
            FROM aggregation_summaries a
            JOIN intersections i ON i.id = a.intersection_id
            WHERE {where}
            GROUP BY
                a.intersection_id, i.name, a.street_id, a.direction, a.object_type,
                DATE_TRUNC('{trunc}', a.window_start)
            ORDER BY
                DATE_TRUNC('{trunc}', a.window_start),
                a.intersection_id, a.street_id, a.direction, a.object_type
        """

    return sql, params, source
