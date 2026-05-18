"""add local warrant columns (W-Local 1/2/3)

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-18
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Per-intersection threshold configuration
    op.add_column("intersections", sa.Column("w_local_1_threshold", sa.Float(), nullable=False, server_default="0.6"))
    op.add_column("intersections", sa.Column("w_local_2_threshold", sa.Float(), nullable=False, server_default="0.7"))
    op.add_column("intersections", sa.Column("w_local_3_min_pcu",   sa.Float(), nullable=False, server_default="30.0"))

    # Local warrant results on recommendations (nullable — old rows have no values)
    op.add_column("recommendations", sa.Column("w_local_1_met",          sa.Boolean(), nullable=True))
    op.add_column("recommendations", sa.Column("w_local_1_confidence",   sa.Float(),   nullable=True))
    op.add_column("recommendations", sa.Column("w_local_2_met",          sa.Boolean(), nullable=True))
    op.add_column("recommendations", sa.Column("w_local_2_confidence",   sa.Float(),   nullable=True))
    op.add_column("recommendations", sa.Column("w_local_3_met",          sa.Boolean(), nullable=True))
    op.add_column("recommendations", sa.Column("w_local_3_confidence",   sa.Float(),   nullable=True))

    # Per-chunk signal-off flag on timing recommendations
    op.add_column(
        "timing_recommendations",
        sa.Column("signal_off", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("timing_recommendations", "signal_off")
    op.drop_column("recommendations", "w_local_3_confidence")
    op.drop_column("recommendations", "w_local_3_met")
    op.drop_column("recommendations", "w_local_2_confidence")
    op.drop_column("recommendations", "w_local_2_met")
    op.drop_column("recommendations", "w_local_1_confidence")
    op.drop_column("recommendations", "w_local_1_met")
    op.drop_column("intersections", "w_local_3_min_pcu")
    op.drop_column("intersections", "w_local_2_threshold")
    op.drop_column("intersections", "w_local_1_threshold")
