import hashlib
import hmac
from datetime import datetime, timezone

from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from common.models import User, UserSession, Log
from fastapi import Depends, HTTPException, Query
from common.database import get_db, SessionLocal
from sqlalchemy.orm import Session
from typing import Annotated, Optional
from os import getenv


SUPER_KEY = getenv("SUPER_KEY")
bearer_scheme = HTTPBearer()


def _hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def get_bearer_token(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer_scheme)]
) -> str:
    return credentials.credentials


def require_superuser(
    token: Annotated[str, Depends(get_bearer_token)]
) -> None:
    if not SUPER_KEY:
        raise HTTPException(status_code=500, detail="Superuser key not set")

    if not hmac.compare_digest(token.encode(), SUPER_KEY.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")


def get_current_user(
    token: Annotated[str, Depends(get_bearer_token)],
    db: Annotated[Session, Depends(get_db)]
) -> User:
    token_hash = _hash_session_token(token)
    session = (
        db.query(UserSession)
        .filter(
            UserSession.token_hash == token_hash,
            UserSession.expires_at > datetime.now(timezone.utc),
        )
        .first()
    )
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return session.user


def get_user_from_token(token: str) -> Optional[User]:
    """Look up a user by session token. Used for WS/SSE where headers aren't available."""
    db = SessionLocal()
    try:
        token_hash = _hash_session_token(token)
        session = (
            db.query(UserSession)
            .filter(
                UserSession.token_hash == token_hash,
                UserSession.expires_at > datetime.now(timezone.utc),
            )
            .first()
        )
        return session.user if session else None
    finally:
        db.close()


def log_and_commit(
    message: str,
    db: Session
) -> None:
    db_log = Log(message=message)
    db.add(db_log)
    db.commit()