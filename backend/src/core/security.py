from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
import jwt
from passlib.context import CryptContext

from src.config import get_settings
from src.core.exceptions import AuthenticationError

settings = get_settings()

pwd_context = CryptContext(
    schemes=["argon2", "bcrypt"],
    deprecated="auto",
)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain password against a stored hash."""
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """Generate an Argon2 password hash."""
    return pwd_context.hash(password)


def create_access_token(
    subject: str,
    role: str,
    institutional_id: str,
    expires_delta: Optional[timedelta] = None,
    extra_claims: Optional[Dict[str, Any]] = None,
) -> str:
    """Create a signed JWT access token with standardized claims."""
    now = datetime.now(timezone.utc)
    if expires_delta:
        expire = now + expires_delta
    else:
        expire = now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode: Dict[str, Any] = {
        "sub": str(subject),
        "role": str(role),
        "institutional_id": str(institutional_id),
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
    }

    if extra_claims:
        to_encode.update(extra_claims)

    encoded_jwt = jwt.encode(
        to_encode,
        settings.SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )
    return encoded_jwt


def decode_access_token(token: str) -> Dict[str, Any]:
    """Decode and validate a JWT access token, returning the payload claims."""
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
    except jwt.ExpiredSignatureError as e:
        raise AuthenticationError("Access token has expired", {"error": "token_expired"}) from e
    except jwt.InvalidTokenError as e:
        raise AuthenticationError("Invalid access token", {"error": "invalid_token"}) from e

    # Validate essential claims
    if "sub" not in payload or "role" not in payload or "institutional_id" not in payload:
        raise AuthenticationError(
            "Access token is missing required claims (sub, role, institutional_id)",
            {"missing_claims": True},
        )

    return payload
