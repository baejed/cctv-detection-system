"""add simulation_results table

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-18
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "simulation_results",
        sa.Column("id",                  sa.Integer(),     primary_key=True, autoincrement=True),
        sa.Column("intersection_id",     sa.Integer(),     sa.ForeignKey("intersections.id",  ondelete="CASCADE"), nullable=False),
        sa.Column("recommendation_id",   sa.Integer(),     sa.ForeignKey("recommendations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("chunk_name",          sa.String(50),    nullable=False),
        sa.Column("delay_before",        sa.Float(),       nullable=False),
        sa.Column("delay_after",         sa.Float(),       nullable=False),
        sa.Column("volume_pcu_hr",       sa.Float(),       nullable=False, server_default="0"),
        sa.Column("vehicle_hours_saved", sa.Float(),       nullable=False, server_default="0"),
        sa.Column("queue_series_before", postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.Column("queue_series_after",  postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.Column("generated_at",        sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_simulation_results_intersection_id", "simulation_results", ["intersection_id"])
    op.create_index("ix_simulation_results_recommendation_id", "simulation_results", ["recommendation_id"])


def downgrade() -> None:
    op.drop_index("ix_simulation_results_recommendation_id", table_name="simulation_results")
    op.drop_index("ix_simulation_results_intersection_id",   table_name="simulation_results")
    op.drop_table("simulation_results")
