"""add user_sessions table, drop legacy session columns from users

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-13
"""
from typing import Sequence, Union
import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_sessions",
        sa.Column("id",         sa.Integer(),                  primary_key=True, autoincrement=True),
        sa.Column("user_id",    sa.Integer(),                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(64),                 nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True),    nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),    nullable=False, server_default=sa.text("NOW()")),
    )
    op.create_index("idx_user_sessions_token_hash", "user_sessions", ["token_hash"], unique=True)
    op.create_index("idx_user_sessions_user_id",    "user_sessions", ["user_id"])
    op.create_index("idx_user_sessions_expires_at", "user_sessions", ["expires_at"])

    # Drop legacy single-session columns — IF EXISTS so this is safe on fresh DBs
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS session")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS session_expires_at")


def downgrade() -> None:
    op.drop_table("user_sessions")
    op.add_column("users", sa.Column("session", sa.String(255), nullable=True))
