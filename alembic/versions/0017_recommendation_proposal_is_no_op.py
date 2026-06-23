"""add proposal_is_no_op to recommendations

Lets the frontend render the simulation as informational ("compare current vs
Webster") even when Webster doesn't beat the existing timing on any chunk,
rather than the previous behaviour of deleting the timing + sim rows outright.

Revision ID: 0017
Revises: 0016
Create Date: 2026-06-23
"""
from alembic import op
import sqlalchemy as sa


revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "recommendations",
        sa.Column(
            "proposal_is_no_op",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("recommendations", "proposal_is_no_op")
