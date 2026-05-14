"""recommendations metrics + history support

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-14
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("recommendations", sa.Column("major_volume", sa.Integer(), nullable=True))
    op.add_column("recommendations", sa.Column("minor_volume", sa.Integer(), nullable=True))
    op.add_column("recommendations", sa.Column("peds", sa.Integer(), nullable=True))
    op.add_column("recommendations", sa.Column("vpm", sa.Integer(), nullable=True))
    op.add_column("recommendations", sa.Column("phf", sa.Float(), nullable=True))
    op.add_column("recommendations", sa.Column("recommended_confidence", sa.Float(), nullable=True))
    op.add_column("recommendations", sa.Column("hour_start", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        "ix_recommendations_intersection_generated",
        "recommendations",
        ["intersection_id", sa.text("generated_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_recommendations_intersection_generated", table_name="recommendations")
    op.drop_column("recommendations", "hour_start")
    op.drop_column("recommendations", "recommended_confidence")
    op.drop_column("recommendations", "phf")
    op.drop_column("recommendations", "vpm")
    op.drop_column("recommendations", "peds")
    op.drop_column("recommendations", "minor_volume")
    op.drop_column("recommendations", "major_volume")
