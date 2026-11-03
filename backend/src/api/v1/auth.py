from fastapi import APIRouter, Depends, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import get_settings
from src.core.exceptions import AuthenticationError
from src.core.permissions import get_current_user
from src.core.security import create_access_token, verify_password
from src.database import get_db_session
from src.models.user import AccountStatus, User
from src.schemas.auth import LoginRequest, TokenResponse, UserContextResponse

settings = get_settings()

router = APIRouter(prefix="/api/v1/auth", tags=["Authentication & Context"])


@router.post(
    "/login",
    response_model=TokenResponse,
    status_code=status.HTTP_200_OK,
    summary="Authenticate user and issue JWT access token",
)
async def login(
    payload: LoginRequest,
    db: AsyncSession = Depends(get_db_session),
):
    """
    Authenticate user by institutional ID or email with plaintext password.
    Returns signed JWT access token and user context without leaking account existence.
    """
    username = payload.username.strip()

    stmt = (
        select(User)
        .options(selectinload(User.face_profile))
        .where(
            or_(
                User.institutional_id == username,
                User.email == username,
                func.lower(User.institutional_id) == username.lower(),
                func.lower(User.email) == username.lower(),
            )
        )
    )
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user or not verify_password(payload.password, user.password_hash):
        raise AuthenticationError("Invalid username or password", {"field": "credentials"})

    if user.account_status != AccountStatus.ACTIVE:
        raise AuthenticationError(
            f"User account is {user.account_status.value.lower()}",
            {"account_status": user.account_status.value},
        )

    token = create_access_token(
        subject=str(user.id),
        role=user.role.value,
        institutional_id=user.institutional_id,
    )

    face_state = "UNREGISTERED"
    if user.face_profile and user.face_profile.registration_state:
        face_state = user.face_profile.registration_state.value

    return TokenResponse(
        access_token=token,
        token_type="bearer",
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=UserContextResponse(
            id=user.id,
            institutional_id=user.institutional_id,
            email=user.email,
            full_name=user.full_name,
            role=user.role,
            face_registration_state=face_state,
        ),
    )


@router.get("/me", response_model=UserContextResponse, summary="Retrieve authenticated user profile")
async def get_current_user_context(current_user: User = Depends(get_current_user)):
    face_state = "UNREGISTERED"
    if current_user.face_profile and current_user.face_profile.registration_state:
        face_state = current_user.face_profile.registration_state.value

    return UserContextResponse(
        id=current_user.id,
        institutional_id=current_user.institutional_id,
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role,
        face_registration_state=face_state,
    )
