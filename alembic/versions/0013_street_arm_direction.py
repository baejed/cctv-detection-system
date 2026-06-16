"""add arm_direction to streets

Revision ID: 0013
Revises: 0012
Create Date: 2026-06-09
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "streets",
        sa.Column("arm_direction", sa.String(20), nullable=False, server_default="unknown"),
    )


def downgrade() -> None:
    op.drop_column("streets", "arm_direction")
