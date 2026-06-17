"""baseline - schema already established via init.sql

Revision ID: 0001
Revises:
Create Date: 2026-04-22
"""
from typing import Sequence, Union

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Schema exists from init.sql; mark this revision as applied with:
    #   alembic stamp 0001
    pass


def downgrade() -> None:
    pass
