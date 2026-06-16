"""add wizard_step to users

Revision ID: 0015
Revises: 0014
Create Date: 2026-06-15
"""
from alembic import op
import sqlalchemy as sa

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("wizard_step", sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "wizard_step")
