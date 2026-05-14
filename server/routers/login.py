import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from common.models import User, UserSession
from server.utils import log_and_commit, get_current_user, get_bearer_token, _hash_session_token
from server.schemas import UserBase
from common.database import get_db
from server.rate_limit import limiter
from sqlalchemy.orm import Session
from typing import Annotated
from bcrypt import checkpw
from os import urandom

SESSION_TTL_HOURS = int(os.getenv("SESSION_TTL_HOURS", "24"))


router = APIRouter(
    prefix="/login",
    tags=["Login"]
)


@router.post("/")
@limiter.limit("10/minute")
def login(
    request: Request,
    user: UserBase,
    db: Session = Depends(get_db)
) -> dict[str, str]:
    db_user = db.query(User).filter(User.username == user.username).first()

    if not db_user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not checkpw(user.password.encode("utf-8"), db_user.hash.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Prune stale sessions for this user before issuing a new one
    db.query(UserSession).filter(
        UserSession.user_id == int(db_user.id),  # type: ignore
        UserSession.expires_at < datetime.now(timezone.utc),
    ).delete(synchronize_session=False)

    token = urandom(32).hex()
    session = UserSession(
        user_id=int(db_user.id),  # type: ignore
        token_hash=_hash_session_token(token),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=SESSION_TTL_HOURS),
    )
    db.add(session)
    log_and_commit(f"User {db_user.username} logged in", db)
    return {"token": token}


@router.delete("/")
def logout(
    token: Annotated[str, Depends(get_bearer_token)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, str]:
    token_hash = _hash_session_token(token)
    session = db.query(UserSession).filter(UserSession.token_hash == token_hash).first()
    if session:
        db.delete(session)
    log_and_commit(f"User {user.username} logged out", db)
    return {"detail": "Logged out"}