"""Domain exceptions and global FastAPI error handlers."""

from typing import Any, Dict, Optional
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse


class AttendanceDomainError(Exception):
    """Base class for attendance domain exceptions."""

    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


class AuthenticationError(AttendanceDomainError):
    """Raised when authentication credentials or token are invalid or missing."""
    pass


class UnauthorizedRoleError(AttendanceDomainError):
    """Raised when an authenticated user does not have the required role."""
    pass


class OutOfScopeError(AttendanceDomainError):
    """Raised when a faculty member attempts to access an offering outside their active assignment or delegation."""
    pass


class EligibilityError(AttendanceDomainError):
    """Raised when a student attendance action violates date-bounded enrollment eligibility."""
    pass


class AmendmentWindowExpiredError(AttendanceDomainError):
    """Raised when an attendance correction is attempted after the allowed correction window has expired."""
    pass


class EntityNotFoundError(AttendanceDomainError):
    """Raised when a requested domain entity is not found."""
    pass


class DuplicateSessionError(AttendanceDomainError):
    """Raised when an attendance session with identical assignment, date, and period sequence already exists."""
    pass


class ConflictError(AttendanceDomainError):
    """Raised when an operation conflicts with domain constraints or invariants (e.g. self-delegation)."""
    pass


class StaleAmendmentError(AttendanceDomainError):
    """Raised when an amendment is attempted against a stale expected previous status (optimistic concurrency conflict)."""
    pass


class BiometricValidationError(AttendanceDomainError):
    """Raised when biometric template or quality validation fails."""
    pass


def register_exception_handlers(app: FastAPI) -> None:
    """Register FastAPI exception handlers that translate domain errors to standard HTTP responses."""

    @app.exception_handler(AuthenticationError)
    async def auth_error_handler(request: Request, exc: AuthenticationError):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={
                "error": "AUTHENTICATION_FAILED",
                "message": exc.message,
                "details": exc.details,
            },
            headers={"WWW-Authenticate": "Bearer"},
        )

    @app.exception_handler(UnauthorizedRoleError)
    async def role_error_handler(request: Request, exc: UnauthorizedRoleError):
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={
                "error": "INSUFFICIENT_ROLE",
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(OutOfScopeError)
    async def out_of_scope_handler(request: Request, exc: OutOfScopeError):
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={
                "error": "OUT_OF_SCOPE",
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(EligibilityError)
    async def eligibility_handler(request: Request, exc: EligibilityError):
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "error": "STUDENT_INELIGIBLE",
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(AmendmentWindowExpiredError)
    async def amendment_expired_handler(request: Request, exc: AmendmentWindowExpiredError):
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={
                "error": "AMENDMENT_WINDOW_EXPIRED",
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(EntityNotFoundError)
    async def not_found_handler(request: Request, exc: EntityNotFoundError):
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={
                "error": "NOT_FOUND",
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(DuplicateSessionError)
    async def duplicate_session_handler(request: Request, exc: DuplicateSessionError):
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={
                "error": "DUPLICATE_SESSION",
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(ConflictError)
    async def conflict_error_handler(request: Request, exc: ConflictError):
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "error": "CONFLICT_ERROR",
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(StaleAmendmentError)
    async def stale_amendment_handler(request: Request, exc: StaleAmendmentError):
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={
                "error": "STALE_AMENDMENT_CONFLICT",
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(BiometricValidationError)
    async def biometric_validation_handler(request: Request, exc: BiometricValidationError):
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "error": "BIOMETRIC_VALIDATION_FAILED",
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(AttendanceDomainError)
    async def generic_domain_error_handler(request: Request, exc: AttendanceDomainError):
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "error": "DOMAIN_ERROR",
                "message": exc.message,
                "details": exc.details,
            },
        )
