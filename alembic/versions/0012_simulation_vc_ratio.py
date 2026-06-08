"""add vc_ratio columns to simulation_results

Revision ID: 0012
Revises: 0011
Create Date: 2026-06-08
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("simulation_results", sa.Column("vc_ratio_before", sa.Float(), nullable=True))
    op.add_column("simulation_results", sa.Column("vc_ratio_after",  sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("simulation_results", "vc_ratio_after")
    op.drop_column("simulation_results", "vc_ratio_before")
