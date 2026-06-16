"""add crossing_width_m to intersections

Revision ID: 0014
Revises: 0013
Create Date: 2026-06-15
"""
from alembic import op
import sqlalchemy as sa

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "intersections",
        sa.Column("crossing_width_m", sa.Float(), nullable=False, server_default="12.0"),
    )


def downgrade() -> None:
    op.drop_column("intersections", "crossing_width_m")
