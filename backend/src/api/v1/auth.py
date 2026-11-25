from datetime import datetime, timezone
from typing import List, Optional, Set
from fastapi import APIRouter, Depends, Request, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import get_settings
from src.core.exceptions import AuthenticationError
from src.core.permissions import (
    ensure_legacy_role_mapping,
    get_current_user,
    resolve_tenant_and_membership,
)
from src.core.security import create_access_token, verify_password
from src.database import get_db_session
from src.models.access_control import (
    AssignmentStatus,
    RoleAssignment,
    RoleAssignmentScope,
    RoleTemplate,
)
from src.models.user import AccountStatus, User, UserRole
from src.schemas.auth import (
    LoginRequest,
    RoleAssignmentSummary,
    TokenResponse,
    UserContextResponse,
)

settings = get_settings()

router = APIRouter(prefix="/api/v1/auth", tags=["Authentication & Context"])

ADMIN_ROLE_CODES: Set[str] = {
    "INSTITUTION_OWNER",
    "CENTRAL_INSTITUTION_ADMIN",
    "CAMPUS_ADMIN",
    "ACCESS_ADMIN",
    "IT_ADMIN",
    "PRIVACY_BIOMETRIC_OFFICER",
    "PRIVACY_BIOMETRIC_GOVERNANCE",
    "INSTITUTIONAL_AUDITOR",
}

FACULTY_ROLE_CODES: Set[str] = {
    "ACADEMIC_REGISTRAR",
    "ADMISSIONS_OFFICER",
    "ENROLLMENT_OFFICER",
    "STUDENT_RECORDS_OFFICER",
    "DEPARTMENT_HEAD",
    "DEPARTMENT_HEAD_COORDINATOR",
    "PROGRAM_COORDINATOR",
    "TIMETABLE_COORDINATOR",
    "FACULTY",
    "TEACHING_ASSISTANT",
    "CLASS_ADVISOR",
    "BIOMETRIC_ENROLLMENT_OFFICER",
    "ATTENDANCE_AUDITOR",
}

STUDENT_ROLE_CODES: Set[str] = {
    "STUDENT",
}


def compute_legacy_role(user: User, role_assignments: List[RoleAssignment]) -> UserRole:
    """Compute backward-compatible UserRole (ADMIN, FACULTY, STUDENT) using tiered privilege hierarchy.

    Evaluates active role templates first:
    1. ADMIN if any admin-tier template is assigned.
    2. FACULTY if any academic/teaching/auditor template is assigned.
    3. STUDENT if student template is assigned.
    4. Fall back to user.role only if no active role templates match.
    """
    assigned_codes = {
        ra.role_template.code
        for ra in role_assignments
        if ra.role_template and ra.role_template.is_active
    }

    if assigned_codes & ADMIN_ROLE_CODES:
        return UserRole.ADMIN

    if assigned_codes & FACULTY_ROLE_CODES:
        return UserRole.FACULTY

    if assigned_codes & STUDENT_ROLE_CODES:
        return UserRole.STUDENT

    return user.role if user.role else UserRole.STUDENT


async def build_user_context(
    user: User,
    db: AsyncSession,
    request: Optional[Request] = None,
) -> UserContextResponse:
    """Assemble UserContextResponse with IAC v1 assignments, scoping, and permissions."""
    face_state = "UNREGISTERED"
    if user.face_profile and user.face_profile.registration_state:
        face_state = user.face_profile.registration_state.value

    # Resolve active tenant and membership context
    inst_id, membership = await resolve_tenant_and_membership(request, user, db)

    # Ensure legacy role mapping if membership has no active role assignment
    await ensure_legacy_role_mapping(user, membership, db)

    # Query active role assignments with temporal bounds matching AuthorizationEvaluator
    now = datetime.now(timezone.utc)
    assignment_stmt = (
        select(RoleAssignment)
        .options(
            selectinload(RoleAssignment.role_template).selectinload(RoleTemplate.permissions),
            selectinload(RoleAssignment.scopes).selectinload(RoleAssignmentScope.department),
        )
        .where(
            and_(
                RoleAssignment.membership_id == membership.id,
                RoleAssignment.status == AssignmentStatus.ACTIVE,
                RoleAssignment.valid_from <= now,
                or_(
                    RoleAssignment.valid_until.is_(None),
                    RoleAssignment.valid_until > now,
                ),
            )
        )
    )
    result = await db.execute(assignment_stmt)
    assignments = result.scalars().all()

    role_assignments_summary: List[RoleAssignmentSummary] = []
    permissions_set: Set[str] = set()

    for assignment in assignments:
        tpl = assignment.role_template
        if not tpl or not tpl.is_active:
            continue

        for perm in tpl.permissions:
            permissions_set.add(perm.code)

        if assignment.scopes:
            for scope in assignment.scopes:
                dept_code = scope.department.code if scope.department else None
                role_assignments_summary.append(
                    RoleAssignmentSummary(
                        role_template_code=tpl.code,
                        role_template_name=tpl.name,
                        scope_type=scope.scope_type.value if hasattr(scope.scope_type, "value") else str(scope.scope_type),
                        department_code=dept_code,
                        valid_from=assignment.valid_from,
                        valid_until=assignment.valid_until,
                    )
                )
        else:
            role_assignments_summary.append(
                RoleAssignmentSummary(
                    role_template_code=tpl.code,
                    role_template_name=tpl.name,
                    scope_type="INSTITUTION",
                    department_code=None,
                    valid_from=assignment.valid_from,
                    valid_until=assignment.valid_until,
                )
            )

    computed_role = compute_legacy_role(user, assignments)

    from datetime import timedelta
    snapshot = {
        "membership_id": str(membership.id) if membership else None,
        "user_id": str(user.id),
        "institution_id": str(inst_id) if inst_id else None,
        "authorization_version": "v1.0",
        "validated_at": now.isoformat(),
        "expires_at": (now + timedelta(days=7)).isoformat(),
        "role_assignments": [
            {
                "id": str(assignment.id),
                "role_template_code": assignment.role_template.code,
                "role_template_name": assignment.role_template.name,
                "scopes": [
                    {
                        "scope_type": s.scope_type.value if hasattr(s.scope_type, "value") else str(s.scope_type),
                        "campus_id": str(s.campus_id) if s.campus_id else None,
                        "department_id": str(s.department_id) if s.department_id else None,
                        "department_code": s.department.code if s.department else None,
                        "program_id": str(s.program_id) if s.program_id else None,
                        "class_section_id": str(s.class_section_id) if s.class_section_id else None,
                    }
                    for s in assignment.scopes
                ] if assignment.scopes else [{"scope_type": "INSTITUTION"}],
                "permissions": [p.code for p in assignment.role_template.permissions] if assignment.role_template else [],
                "valid_from": assignment.valid_from.isoformat() if assignment.valid_from else None,
                "valid_until": assignment.valid_until.isoformat() if assignment.valid_until else None,
            }
            for assignment in assignments if assignment.role_template and assignment.role_template.is_active
        ],
        "effective_permissions": sorted(list(permissions_set)),
    }

    return UserContextResponse(
        id=user.id,
        institutional_id=user.institutional_id,
        email=user.email,
        full_name=user.full_name,
        role=computed_role,
        face_registration_state=face_state,
        institution_id=inst_id,
        membership_id=membership.id if membership else None,
        authorization_version="v1.0",
        authorization_snapshot=snapshot,
        role_assignments=role_assignments_summary,
        permissions=sorted(list(permissions_set)),
    )


@router.post(
    "/login",
    response_model=TokenResponse,
    status_code=status.HTTP_200_OK,
    summary="Authenticate user and issue JWT access token",
)
async def login(
    payload: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """
    Authenticate user by institutional ID or email with plaintext password.
    Returns signed JWT access token and user context without leaking account existence.
    """
    username = payload.username.strip()
    lookup_ids = [username.lower()]
    if username.lower() == "admin":
        lookup_ids.append("admin_meera")

    stmt = (
        select(User)
        .options(selectinload(User.face_profile))
        .where(
            or_(
                func.lower(User.institutional_id).in_(lookup_ids),
                func.lower(User.email).in_(lookup_ids),
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

    user_context = await build_user_context(user, db, request)

    token = create_access_token(
        subject=str(user.id),
        role=user_context.role.value,
        institutional_id=user.institutional_id,
    )

    return TokenResponse(
        access_token=token,
        token_type="bearer",
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=user_context,
    )


@router.get("/me", response_model=UserContextResponse, summary="Retrieve authenticated user profile")
async def get_current_user_context(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    return await build_user_context(current_user, db, request)
