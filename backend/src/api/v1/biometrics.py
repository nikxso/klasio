from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.permissions import require_faculty_or_admin, require_roles
from src.database import get_db_session
from src.models.user import User, UserRole
from src.schemas.biometrics import (
    FaceEnrollmentRequest,
    FaceEnrollmentResponse,
    FaceRevocationRequest,
    FaceRevocationResponse,
)
from src.services.biometric_service import BiometricService

router = APIRouter(prefix="/api/v1/biometrics", tags=["Biometrics"])


@router.post(
    "/enrollment",
    response_model=FaceEnrollmentResponse,
    status_code=status.HTTP_200_OK,
    summary="Enroll or re-enroll a student face biometric template",
)
async def enroll_student_face(
    payload: FaceEnrollmentRequest,
    current_user: User = Depends(require_roles(UserRole.STUDENT, UserRole.FACULTY, UserRole.ADMIN)),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Biometric enrollment endpoint.
    Permits authenticated students to enroll their own biometric profile,
    or authorized Faculty and Admin operators within their institutional scope.
    Applies strict server-side validation on template dimension, L2 normalization,
    quality score, and multi-sample count.
    """
    service = BiometricService(db)
    return await service.enroll_student_face(operator=current_user, payload=payload)


@router.post(
    "/revoke",
    response_model=FaceRevocationResponse,
    status_code=status.HTTP_200_OK,
    summary="Revoke a student face biometric template",
)
async def revoke_student_face(
    payload: FaceRevocationRequest,
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Biometric revocation endpoint.
    Restricted to Admin or authorized Faculty teaching the student.
    Sets registration state to UNREGISTERED and purges template data.
    """
    service = BiometricService(db)
    return await service.revoke_student_face(operator=current_user, payload=payload)
