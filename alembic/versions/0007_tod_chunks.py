"""add tod_chunks table with default chunks for existing intersections

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-18
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DEFAULTS = [
    ("Early Morning", 0,    360),
    ("AM Peak",       360,  540),
    ("Midday",        540,  720),
    ("PM Peak",       720,  1080),
    ("Night",         1080, 1440),
]


def upgrade() -> None:
    op.create_table(
        "tod_chunks",
        sa.Column("id",              sa.Integer(),              primary_key=True, autoincrement=True),
        sa.Column("intersection_id", sa.Integer(),              sa.ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name",            sa.String(50),             nullable=False),
        sa.Column("start_minutes",   sa.Integer(),              nullable=False),
        sa.Column("end_minutes",     sa.Integer(),              nullable=False),
        sa.Column("created_at",      sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
    )
    op.create_index("ix_tod_chunks_intersection_id", "tod_chunks", ["intersection_id"])

    # Seed defaults for every existing intersection
    conn = op.get_bind()
    ids = [row[0] for row in conn.execute(sa.text("SELECT id FROM intersections")).fetchall()]
    if ids:
        rows = [
            {"intersection_id": iid, "name": name, "start_minutes": start, "end_minutes": end}
            for iid in ids
            for name, start, end in _DEFAULTS
        ]
        conn.execute(
            sa.text(
                "INSERT INTO tod_chunks (intersection_id, name, start_minutes, end_minutes) "
                "VALUES (:intersection_id, :name, :start_minutes, :end_minutes)"
            ),
            rows,
        )


def downgrade() -> None:
    op.drop_table("tod_chunks")
