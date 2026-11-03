from datetime import timedelta
import pytest
import jwt
from src.core.security import (
    get_password_hash,
    verify_password,
    create_access_token,
    decode_access_token,
)
from src.core.exceptions import AuthenticationError
from src.config import get_settings

settings = get_settings()


def test_password_hashing_and_verification():
    raw_password = "SuperSecretPassword123!"
    hashed = get_password_hash(raw_password)

    assert hashed != raw_password
    assert hashed.startswith("$argon2")

    assert verify_password(raw_password, hashed) is True
    assert verify_password("WrongPassword!", hashed) is False


def test_create_and_decode_access_token():
    user_id = "11111111-2222-3333-4444-555555555555"
    role = "FACULTY"
    institutional_id = "FAC-2026-001"

    token = create_access_token(
        subject=user_id,
        role=role,
        institutional_id=institutional_id,
    )

    claims = decode_access_token(token)
    assert claims["sub"] == user_id
    assert claims["role"] == role
    assert claims["institutional_id"] == institutional_id
    assert "exp" in claims
    assert "iat" in claims


def test_decode_expired_token():
    user_id = "11111111-2222-3333-4444-555555555555"
    role = "ADMIN"
    institutional_id = "ADM-001"

    expired_token = create_access_token(
        subject=user_id,
        role=role,
        institutional_id=institutional_id,
        expires_delta=timedelta(seconds=-10),
    )

    with pytest.raises(AuthenticationError) as exc_info:
        decode_access_token(expired_token)

    assert "expired" in str(exc_info.value).lower()


def test_decode_invalid_signature():
    token = create_access_token(
        subject="some-id",
        role="STUDENT",
        institutional_id="STU-001",
    )

    tampered_token = token[:-4] + "abcd"

    with pytest.raises(AuthenticationError):
        decode_access_token(tampered_token)


def test_decode_missing_claims():
    incomplete_payload = {
        "sub": "user-without-role",
        # Missing role and institutional_id
    }
    raw_token = jwt.encode(incomplete_payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)

    with pytest.raises(AuthenticationError) as exc_info:
        decode_access_token(raw_token)

    assert "missing required claims" in str(exc_info.value).lower()


def test_settings_security_validation_in_staging_and_production():
    from src.config import Settings

    # Development allows default insecure secret
    dev_settings = Settings(ENVIRONMENT="development")
    assert dev_settings.ENVIRONMENT == "development"

    # Staging with default secret must fail
    with pytest.raises(ValueError) as exc:
        Settings(
            ENVIRONMENT="staging",
            SECRET_KEY="insecure-development-secret-key-change-in-production-min-32-chars-long",
        )
    assert "A secure, non-default SECRET_KEY" in str(exc.value)

    # Staging with short secret must fail
    with pytest.raises(ValueError) as exc:
        Settings(
            ENVIRONMENT="staging",
            SECRET_KEY="short-secret-12345",
        )
    assert "minimum 32 characters" in str(exc.value)

    # Staging with valid strong secret succeeds
    staging_settings = Settings(
        ENVIRONMENT="staging",
        SECRET_KEY="a" * 32,
    )
    assert staging_settings.ENVIRONMENT == "staging"

    # Production with DEBUG=True must fail
    with pytest.raises(ValueError) as exc:
        Settings(
            ENVIRONMENT="production",
            SECRET_KEY="a" * 32,
            DEBUG=True,
        )
    assert "DEBUG mode must be disabled in production" in str(exc.value)

    # CORS origins parsed from comma-separated string
    cors_settings = Settings(
        CORS_ORIGINS="https://attendly.institution.edu, https://staging.attendly.institution.edu"
    )
    assert cors_settings.CORS_ORIGINS == [
        "https://attendly.institution.edu",
        "https://staging.attendly.institution.edu",
    ]
