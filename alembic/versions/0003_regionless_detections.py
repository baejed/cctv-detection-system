"""make regions optional - LEFT JOIN aggregation

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-22
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP VIEW IF EXISTS detection_street_view CASCADE")
    op.execute("""
        CREATE VIEW detection_street_view AS
        SELECT
            d.id, d.cctv_id, d.video_id, d.track_id, d.object_type,
            d.confidence, d.x1, d.y1, d.x2, d.y2, d.time,
            dir.id                           AS detection_in_region_id,
            r.id                             AS region_id,
            COALESCE(r.direction, 'unknown') AS direction,
            s.id                             AS street_id,
            s.name                           AS street_name,
            i.id                             AS intersection_id,
            i.name                           AS intersection_name
        FROM detections d
        JOIN cctvs c ON c.id = d.cctv_id
        JOIN intersections i ON i.id = c.intersection_id
        LEFT JOIN detections_in_regions dir ON dir.detection_id = d.id
        LEFT JOIN regions r ON r.id = dir.region_id
        LEFT JOIN streets s ON s.id = r.street_id
    """)

    op.execute("SELECT remove_continuous_aggregate_policy('aggregation_summaries', if_not_exists => TRUE)")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS aggregation_summaries")
    op.execute("""
        CREATE MATERIALIZED VIEW aggregation_summaries
        WITH (timescaledb.continuous) AS
        SELECT
            i.id                                AS intersection_id,
            i.name                              AS intersection_name,
            s.id                                AS street_id,
            COALESCE(r.direction, 'unknown')    AS direction,
            d.object_type,
            time_bucket('1 minute', d.time)     AS window_start,
            COUNT(*)::int                       AS count
        FROM detections d
        JOIN cctvs c ON c.id = d.cctv_id
        JOIN intersections i ON i.id = c.intersection_id
        LEFT JOIN detections_in_regions dir ON dir.detection_id = d.id
        LEFT JOIN regions r ON r.id = dir.region_id
        LEFT JOIN streets s ON s.id = r.street_id
        GROUP BY i.id, i.name, s.id, COALESCE(r.direction, 'unknown'), d.object_type,
                 time_bucket('1 minute', d.time)
        WITH NO DATA
    """)
    op.execute("""
        SELECT add_continuous_aggregate_policy('aggregation_summaries',
            start_offset      => INTERVAL '1 hour',
            end_offset        => INTERVAL '10 seconds',
            schedule_interval => INTERVAL '30 seconds')
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_agg_intersection ON aggregation_summaries (intersection_id, window_start DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_agg_street ON aggregation_summaries (street_id, window_start DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_agg_window ON aggregation_summaries (window_start DESC)")


def downgrade() -> None:
    # Restore INNER JOIN versions - see migration 0002 for the SQL
    pass
