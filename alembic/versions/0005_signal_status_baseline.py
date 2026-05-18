"""add signal status and existing timing baseline to intersections

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-18
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "intersections",
        sa.Column("signal_status", sa.String(20), nullable=False, server_default="unsignalized"),
    )
    op.add_column(
        "intersections",
        sa.Column("existing_cycle_length", sa.Integer(), nullable=True),
    )
    op.add_column(
        "intersections",
        sa.Column("existing_green_splits", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("intersections", "existing_green_splits")
    op.drop_column("intersections", "existing_cycle_length")
    op.drop_column("intersections", "signal_status")
