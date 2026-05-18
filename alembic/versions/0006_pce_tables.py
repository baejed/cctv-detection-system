"""add pce_overrides and pce_calibrated_values tables

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-18
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pce_overrides",
        sa.Column("id",              sa.Integer(),              primary_key=True, autoincrement=True),
        sa.Column("intersection_id", sa.Integer(),              sa.ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False),
        sa.Column("vehicle_type",    sa.String(50),             nullable=False),
        sa.Column("pce_value",       sa.Float(),                nullable=False),
        sa.Column("created_at",      sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.UniqueConstraint("intersection_id", "vehicle_type", name="uq_pce_overrides_intersection_vehicle"),
    )
    op.create_index("ix_pce_overrides_intersection_id", "pce_overrides", ["intersection_id"])

    op.create_table(
        "pce_calibrated_values",
        sa.Column("id",              sa.Integer(),              primary_key=True, autoincrement=True),
        sa.Column("intersection_id", sa.Integer(),              sa.ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False),
        sa.Column("vehicle_type",    sa.String(50),             nullable=False),
        sa.Column("pce_value",       sa.Float(),                nullable=False),
        sa.Column("calibrated_at",   sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.UniqueConstraint("intersection_id", "vehicle_type", name="uq_pce_calibrated_intersection_vehicle"),
    )
    op.create_index("ix_pce_calibrated_values_intersection_id", "pce_calibrated_values", ["intersection_id"])


def downgrade() -> None:
    op.drop_table("pce_calibrated_values")
    op.drop_table("pce_overrides")
