"""add direction to regions, update views

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-22
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("regions", sa.Column(
        "direction", sa.String(10), nullable=False, server_default="unknown"
    ))

    op.execute("DROP VIEW IF EXISTS detection_street_view CASCADE")
    op.execute("""
        CREATE VIEW detection_street_view AS
        SELECT
            d.id            AS detection_id,
            d.cctv_id,
            d.video_id,
            d.track_id,
            d.object_type,
            d.confidence,
            d.x1, d.y1, d.x2, d.y2,
            d.time,
            dir.id          AS detection_in_region_id,
            r.id            AS region_id,
            r.direction,
            s.id            AS street_id,
            s.name          AS street_name,
            i.id            AS intersection_id,
            i.name          AS intersection_name
        FROM detections            d
        JOIN detections_in_regions dir ON dir.detection_id = d.id
        JOIN regions               r   ON r.id  = dir.region_id
        JOIN streets               s   ON s.id  = r.street_id
        JOIN intersections         i   ON i.id  = s.intersection_id
    """)

    # Recreate continuous aggregate with direction in GROUP BY
    op.execute("SELECT remove_continuous_aggregate_policy('aggregation_summaries', if_not_exists => TRUE)")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS aggregation_summaries")
    op.execute("""
        CREATE MATERIALIZED VIEW aggregation_summaries
        WITH (timescaledb.continuous) AS
        SELECT
            i.id                            AS intersection_id,
            i.name                          AS intersection_name,
            s.id                            AS street_id,
            r.direction,
            d.object_type,
            time_bucket('1 minute', d.time) AS window_start,
            COUNT(*)::int                   AS count
        FROM detections            d
        JOIN detections_in_regions dir ON dir.detection_id = d.id
        JOIN regions               r   ON r.id  = dir.region_id
        JOIN streets               s   ON s.id  = r.street_id
        JOIN intersections         i   ON i.id  = s.intersection_id
        GROUP BY i.id, i.name, s.id, r.direction, d.object_type, time_bucket('1 minute', d.time)
        WITH NO DATA
    """)
    op.execute("""
        SELECT add_continuous_aggregate_policy('aggregation_summaries',
            start_offset => INTERVAL '1 hour',
            end_offset   => INTERVAL '10 seconds',
            schedule_interval => INTERVAL '30 seconds')
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_agg_direction ON aggregation_summaries (direction)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_agg_window ON aggregation_summaries (window_start DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_agg_intersection ON aggregation_summaries (intersection_id, window_start DESC)")


def downgrade() -> None:
    op.execute("SELECT remove_continuous_aggregate_policy('aggregation_summaries', if_not_exists => TRUE)")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS aggregation_summaries")
    op.execute("DROP VIEW IF EXISTS detection_street_view CASCADE")
    op.drop_column("regions", "direction")
    # Restore views without direction - recreate from init.sql manually if needed
