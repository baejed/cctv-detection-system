"""rename default tod_chunks to rush/overnight/evening vocabulary

Revision ID: 0016
Revises: 0015
Create Date: 2026-06-19
"""
from alembic import op
import sqlalchemy as sa


revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


_RENAMES = [
    ("Early Morning", "Overnight"),
    ("AM Peak",       "AM Rush"),
    ("PM Peak",       "PM Rush"),
    ("Night",         "Evening"),
]


def upgrade() -> None:
    conn = op.get_bind()
    for old, new in _RENAMES:
        conn.execute(
            sa.text("UPDATE tod_chunks SET name = :new WHERE name = :old"),
            {"old": old, "new": new},
        )


def downgrade() -> None:
    conn = op.get_bind()
    for old, new in _RENAMES:
        conn.execute(
            sa.text("UPDATE tod_chunks SET name = :old WHERE name = :new"),
            {"old": old, "new": new},
        )
