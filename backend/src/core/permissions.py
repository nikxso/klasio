"""Role and authorization scoping dependency guards."""

from typing import Callable, List, Optional
import uuid
from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import get_settings
from src.core.exceptions import AuthenticationError, UnauthorizedRoleError
from src.core.security import decode_access_token
from src.database import get_db_session
from src.models.user import AccountStatus, User, UserRole

bearer_scheme = HTTPBearer(auto_error=False, scheme_name="BearerAuth")


async def get_current_user(
    auth_header: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db_session),
) -> User:
    """Validate bearer token and resolve active User entity."""
    if not auth_header:
        raise AuthenticationError("Authorization header missing", {"header": "Authorization"})

    token = auth_header.credentials
    claims = decode_access_token(token)

    try:
        user_uuid = uuid.UUID(claims["sub"])
    except (ValueError, TypeError) as e:
        raise AuthenticationError("Invalid user UUID in token subject") from e

    stmt = select(User).options(selectinload(User.face_profile)).where(User.id == user_uuid)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        raise AuthenticationError("User associated with token does not exist")

    if user.account_status != AccountStatus.ACTIVE:
        raise AuthenticationError(f"User account is {user.account_status}")

    return user


def require_roles(*allowed_roles: UserRole) -> Callable:
    """Dependency factory restricting endpoint access to specific institutional roles."""

    async def role_checker(
        request: Request,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db_session),
    ) -> User:
        legacy_allowed = (current_user.role in allowed_roles)

        # Feature-flagged, non-blocking, exception-safe shadow evaluation hook
        settings = get_settings()
        if getattr(settings, "ENABLE_SHADOW_AUTHORIZATION", False):
            try:
                from src.models.access_control import (
                    InstitutionMembership,
                    MembershipStatus,
                    Campus,
                    Delegation,
                )
                from src.models.academic import Department, AcademicTerm, ClassSection
                from src.models.assignment import TeachingAssignment
                from src.models.attendance import AttendanceSession, StudentAttendanceRequest
                from src.services.shadow_evaluator import ShadowAuthorizationEvaluator

                shadow = ShadowAuthorizationEvaluator(db)

                # 1. Resolve correlation ID
                cid = None
                if request and hasattr(request, "headers"):
                    cid = request.headers.get("X-Correlation-ID") or request.headers.get("X-Request-ID")
                if not cid:
                    cid = f"shadow-{uuid.uuid4().hex[:12]}"

                # 2. Resolve active institution context
                active_inst_id: Optional[uuid.UUID] = None
                hdr_inst = request.headers.get("X-Institution-ID") if request and hasattr(request, "headers") else None

                if hdr_inst:
                    try:
                        inst_candidate = uuid.UUID(hdr_inst)
                        mem_stmt = select(InstitutionMembership.id).where(
                            InstitutionMembership.user_id == current_user.id,
                            InstitutionMembership.institution_id == inst_candidate,
                            InstitutionMembership.status == MembershipStatus.ACTIVE,
                        )
                        if (await db.execute(mem_stmt)).scalar_one_or_none():
                            active_inst_id = inst_candidate
                    except (ValueError, TypeError):
                        pass

                if not active_inst_id:
                    # Discover all active memberships for current user
                    mem_stmt = select(InstitutionMembership.institution_id).where(
                        InstitutionMembership.user_id == current_user.id,
                        InstitutionMembership.status == MembershipStatus.ACTIVE,
                    )
                    active_inst_ids = (await db.execute(mem_stmt)).scalars().all()
                    if len(active_inst_ids) == 1:
                        active_inst_id = active_inst_ids[0]

                # If tenant context could not be determined unambiguously, skip with NO_TENANT_CONTEXT
                if not active_inst_id:
                    shadow.record_skipped_evaluation(
                        actor_user_id=current_user.id,
                        skip_reason="NO_TENANT_CONTEXT",
                        legacy_allowed=legacy_allowed,
                        correlation_id=cid,
                    )
                else:
                    # 3. Resolve target resource context from request path parameters
                    resource_type: Optional[str] = None
                    resource_id: Optional[uuid.UUID] = None
                    target_resource_institution_id: Optional[uuid.UUID] = None
                    has_resource_param = False

                    path_params = request.path_params if request and hasattr(request, "path_params") else {}

                    if "teaching_assignment_id" in path_params:
                        has_resource_param = True
                        try:
                            ta_uuid = uuid.UUID(str(path_params["teaching_assignment_id"]))
                            ta_stmt = (
                                select(ClassSection.institution_id)
                                .join(TeachingAssignment, TeachingAssignment.class_section_id == ClassSection.id)
                                .where(TeachingAssignment.id == ta_uuid)
                            )
                            ta_inst = (await db.execute(ta_stmt)).scalar_one_or_none()
                            if ta_inst:
                                resource_type = "TEACHING_ASSIGNMENT"
                                resource_id = ta_uuid
                                target_resource_institution_id = ta_inst
                        except (ValueError, TypeError):
                            pass

                    elif "session_id" in path_params:
                        has_resource_param = True
                        try:
                            sess_uuid = uuid.UUID(str(path_params["session_id"]))
                            sess_stmt = (
                                select(ClassSection.institution_id)
                                .join(TeachingAssignment, AttendanceSession.teaching_assignment_id == TeachingAssignment.id)
                                .join(ClassSection, TeachingAssignment.class_section_id == ClassSection.id)
                                .where(AttendanceSession.id == sess_uuid)
                            )
                            sess_inst = (await db.execute(sess_stmt)).scalar_one_or_none()
                            if sess_inst:
                                resource_type = "ATTENDANCE_SESSION"
                                resource_id = sess_uuid
                                target_resource_institution_id = sess_inst
                        except (ValueError, TypeError):
                            pass

                    elif "delegation_id" in path_params:
                        has_resource_param = True
                        try:
                            del_uuid = uuid.UUID(str(path_params["delegation_id"]))
                            del_stmt = select(Delegation.institution_id).where(Delegation.id == del_uuid)
                            del_inst = (await db.execute(del_stmt)).scalar_one_or_none()
                            if del_inst:
                                resource_type = "DELEGATION"
                                resource_id = del_uuid
                                target_resource_institution_id = del_inst
                        except (ValueError, TypeError):
                            pass

                    elif "request_id" in path_params:
                        has_resource_param = True
                        try:
                            req_uuid = uuid.UUID(str(path_params["request_id"]))
                            req_stmt = select(StudentAttendanceRequest.institution_id).where(
                                StudentAttendanceRequest.id == req_uuid
                            )
                            req_inst = (await db.execute(req_stmt)).scalar_one_or_none()
                            if req_inst:
                                resource_type = "STUDENT_ATTENDANCE_REQUEST"
                                resource_id = req_uuid
                                target_resource_institution_id = req_inst
                        except (ValueError, TypeError):
                            pass

                    elif "class_section_id" in path_params or "section_id" in path_params:
                        has_resource_param = True
                        sec_raw = path_params.get("class_section_id") or path_params.get("section_id")
                        try:
                            sec_uuid = uuid.UUID(str(sec_raw))
                            sec_stmt = select(ClassSection.institution_id).where(ClassSection.id == sec_uuid)
                            sec_inst = (await db.execute(sec_stmt)).scalar_one_or_none()
                            if sec_inst:
                                resource_type = "CLASS_SECTION"
                                resource_id = sec_uuid
                                target_resource_institution_id = sec_inst
                        except (ValueError, TypeError):
                            pass

                    elif "department_id" in path_params:
                        has_resource_param = True
                        try:
                            dept_uuid = uuid.UUID(str(path_params["department_id"]))
                            dept_stmt = select(Department.institution_id).where(Department.id == dept_uuid)
                            dept_inst = (await db.execute(dept_stmt)).scalar_one_or_none()
                            if dept_inst:
                                resource_type = "DEPARTMENT"
                                resource_id = dept_uuid
                                target_resource_institution_id = dept_inst
                        except (ValueError, TypeError):
                            pass

                    # 4. Map permission code
                    req_path = request.url.path if request and hasattr(request, "url") else ""
                    if "/gallery" in req_path:
                        shadow_perm = "attendance.session.start"
                    elif "/roster" in req_path:
                        shadow_perm = "attendance.candidate.view"
                    elif "/delegations" in req_path:
                        shadow_perm = "delegation.create"
                    elif "/amendments" in req_path:
                        shadow_perm = (
                            "attendance.amendment.approve"
                            if UserRole.ADMIN in allowed_roles
                            else "attendance.amendment.request"
                        )
                    elif "/analytics" in req_path or "/overview" in req_path:
                        shadow_perm = "reports.export" if "/export" in req_path else "reports.view"
                    elif UserRole.ADMIN in allowed_roles:
                        shadow_perm = "institution.manage"
                    elif UserRole.FACULTY in allowed_roles:
                        shadow_perm = "attendance.session.start"
                    else:
                        shadow_perm = "attendance.session.view"

                    # 5. Handle missing resource or tenant mismatch
                    if has_resource_param and not resource_id:
                        # Resource parameter was in URL, but entity could not be resolved from DB
                        shadow.record_skipped_evaluation(
                            actor_user_id=current_user.id,
                            skip_reason="NO_RESOURCE_CONTEXT",
                            legacy_allowed=legacy_allowed,
                            correlation_id=cid,
                            institution_id=active_inst_id,
                            permission_code=shadow_perm,
                        )
                    elif has_resource_param and target_resource_institution_id != active_inst_id:
                        # Requested resource's institution does not match active actor context!
                        shadow.record_skipped_evaluation(
                            actor_user_id=current_user.id,
                            skip_reason="RESOURCE_TENANT_MISMATCH",
                            legacy_allowed=legacy_allowed,
                            correlation_id=cid,
                            institution_id=active_inst_id,
                            permission_code=shadow_perm,
                            resource_type=resource_type,
                            resource_id=resource_id,
                            target_resource_institution_id=target_resource_institution_id,
                        )
                    else:
                        await shadow.shadow_evaluate(
                            legacy_allowed=legacy_allowed,
                            actor_user_id=current_user.id,
                            permission_code=shadow_perm,
                            institution_id=active_inst_id,
                            resource_type=resource_type,
                            resource_id=resource_id,
                            target_resource_institution_id=target_resource_institution_id,
                            correlation_id=cid,
                        )
            except Exception:
                # Shadow evaluation MUST NEVER disrupt production requests or alter legacy outcomes
                import logging
                logging.getLogger("klasio.auth.shadow").warning(
                    "Shadow authorization hook suppressed an internal error"
                )

        if not legacy_allowed:
            role_names = [r.value for r in allowed_roles]
            raise UnauthorizedRoleError(
                f"Action requires one of roles: {role_names}, but user has role: {current_user.role.value}"
            )
        return current_user

    return role_checker


# Convenient role dependency shortcuts
require_admin = require_roles(UserRole.ADMIN)
require_faculty = require_roles(UserRole.FACULTY)
require_student = require_roles(UserRole.STUDENT)
require_faculty_or_admin = require_roles(UserRole.FACULTY, UserRole.ADMIN)
