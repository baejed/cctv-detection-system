"""add timing config columns to intersections and timing_recommendations table

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-18
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("intersections", sa.Column("lost_time_per_phase", sa.Integer(), nullable=False, server_default="4"))
    op.add_column("intersections", sa.Column("all_red_clearance",   sa.Integer(), nullable=False, server_default="3"))
    op.add_column("intersections", sa.Column("min_cycle_length",    sa.Integer(), nullable=False, server_default="40"))
    op.add_column("intersections", sa.Column("max_cycle_length",    sa.Integer(), nullable=False, server_default="120"))

    op.create_table(
        "timing_recommendations",
        sa.Column("id",               sa.Integer(),               primary_key=True, autoincrement=True),
        sa.Column("intersection_id",  sa.Integer(),               sa.ForeignKey("intersections.id",  ondelete="CASCADE"), nullable=False),
        sa.Column("recommendation_id", sa.Integer(),              sa.ForeignKey("recommendations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("chunk_name",       sa.String(50),              nullable=False),
        sa.Column("cycle_length",     sa.Integer(),               nullable=False),
        sa.Column("green_splits",     sa.JSON(),                  nullable=False),
        sa.Column("effective_date",   sa.DateTime(timezone=True), nullable=False),
        sa.Column("pce_tier_used",    sa.String(20),              nullable=False),
        sa.Column("generated_at",     sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
    )
    op.create_index("ix_timing_recommendations_intersection_id",  "timing_recommendations", ["intersection_id"])
    op.create_index("ix_timing_recommendations_recommendation_id", "timing_recommendations", ["recommendation_id"])


def downgrade() -> None:
    op.drop_table("timing_recommendations")
    op.drop_column("intersections", "lost_time_per_phase")
    op.drop_column("intersections", "all_red_clearance")
    op.drop_column("intersections", "min_cycle_length")
    op.drop_column("intersections", "max_cycle_length")
