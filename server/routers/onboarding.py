from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from common.database import get_db
from common.models import User
from server.utils import get_current_user

router = APIRouter(prefix="/onboarding", tags=["Onboarding"])


class WizardProgressResponse(BaseModel):
    step: Optional[str] = None


class WizardProgressUpdate(BaseModel):
    step: Optional[str] = None


@router.get("/progress", response_model=WizardProgressResponse)
def get_wizard_progress(
    user: Annotated[User, Depends(get_current_user)],
) -> WizardProgressResponse:
    return WizardProgressResponse(step=user.wizard_step)  # type: ignore[arg-type]


@router.patch("/progress", response_model=WizardProgressResponse)
def set_wizard_progress(
    body: WizardProgressUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> WizardProgressResponse:
    user.wizard_step = body.step  # type: ignore[assignment]
    db.commit()
    return WizardProgressResponse(step=user.wizard_step)  # type: ignore[arg-type]
