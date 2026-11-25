"""Role and authorization scoping dependency guards implementing Institutional Access Control v1."""

from typing import Callable, List, Optional, Tuple
import uuid
from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select, and_
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import get_settings
from src.core.exceptions import AuthenticationError, UnauthorizedRoleError
from src.core.security import decode_access_token
from src.database import get_db_session
from src.models.user import AccountStatus, User, UserRole
from src.models.access_control import (
    DEFAULT_INSTITUTION_ID,
    Institution,
    InstitutionStatus,
    InstitutionMembership,
    MembershipStatus,
    RoleTemplate,
    RoleAssignment,
    AssignmentStatus,
    RoleScopeType,
    RoleAssignmentScope,
    AuthorizationAudit,
    AuditOutcome,
)
from src.services.authorization_evaluator import AuthorizationEvaluator, LEGACY_PERMISSION_MAP

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


async def resolve_tenant_and_membership(
    request: Optional[Request],
    user: User,
    db: AsyncSession,
) -> Tuple[uuid.UUID, InstitutionMembership]:
    """Resolve active institution context and ensure valid membership."""
    hdr_inst = request.headers.get("X-Institution-ID") if request and hasattr(request, "headers") else None

    if hdr_inst:
        try:
            inst_candidate = uuid.UUID(hdr_inst)
            mem_stmt = select(InstitutionMembership).where(
                InstitutionMembership.user_id == user.id,
                InstitutionMembership.institution_id == inst_candidate,
                InstitutionMembership.status == MembershipStatus.ACTIVE,
            )
            res = await db.execute(mem_stmt)
            membership = res.scalar_one_or_none()
            if membership:
                return inst_candidate, membership
        except (ValueError, TypeError):
            pass

    # Discover active memberships for current user
    mem_stmt = select(InstitutionMembership).where(
        InstitutionMembership.user_id == user.id,
        InstitutionMembership.status == MembershipStatus.ACTIVE,
    )
    memberships = (await db.execute(mem_stmt)).scalars().all()
    if memberships:
        return memberships[0].institution_id, memberships[0]

    # Provision membership in default institution if none exists
    inst_res = await db.execute(select(Institution).limit(1))
    inst = inst_res.scalar_one_or_none()
    if not inst:
        inst = Institution(
            id=uuid.UUID(DEFAULT_INSTITUTION_ID),
            code="KLASIO_MAIN",
            name="Klasio Institute of Technology",
            status=InstitutionStatus.ACTIVE,
        )
        db.add(inst)
        await db.flush()

    membership = InstitutionMembership(
        institution_id=inst.id,
        user_id=user.id,
        status=MembershipStatus.ACTIVE,
    )
    db.add(membership)
    await db.flush()
    return inst.id, membership


async def ensure_legacy_role_mapping(
    user: User,
    membership: InstitutionMembership,
    db: AsyncSession,
) -> None:
    """Compatibility provisioner: map unassigned legacy accounts to canonical role templates."""
    stmt = (
        select(RoleAssignment.id)
        .where(
            RoleAssignment.membership_id == membership.id,
            RoleAssignment.status == AssignmentStatus.ACTIVE,
        )
        .limit(1)
    )
    existing = (await db.execute(stmt)).scalar_one_or_none()
    if existing:
        return

    target_code = "STUDENT"
    if user.role == UserRole.ADMIN:
        target_code = "CENTRAL_INSTITUTION_ADMIN"
    elif user.role == UserRole.FACULTY:
        target_code = "FACULTY"
    elif user.role == UserRole.STUDENT:
        target_code = "STUDENT"

    tpl_stmt = select(RoleTemplate).where(RoleTemplate.code == target_code)
    tpl = (await db.execute(tpl_stmt)).scalar_one_or_none()
    if not tpl:
        return

    assignment = RoleAssignment(
        institution_id=membership.institution_id,
        membership_id=membership.id,
        role_template_id=tpl.id,
        status=AssignmentStatus.ACTIVE,
        reason="Automated migration backfill from legacy account category",
    )
    db.add(assignment)
    await db.flush()

    scope = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=membership.institution_id,
        scope_type=RoleScopeType.INSTITUTION,
    )
    db.add(scope)
    await db.flush()


def extract_target_resource(
    request: Request,
    resource_type: Optional[str] = None,
    resource_param: Optional[str] = None,
) -> Tuple[Optional[str], Optional[uuid.UUID]]:
    """Resolve target resource type and UUID from path parameters."""
    if not request or not hasattr(request, "path_params"):
        return None, None

    path_params = request.path_params

    if resource_type and resource_param and resource_param in path_params:
        try:
            return resource_type, uuid.UUID(str(path_params[resource_param]))
        except (ValueError, TypeError):
            return resource_type, None

    for param_name, res_type in [
        ("teaching_assignment_id", "TEACHING_ASSIGNMENT"),
        ("session_id", "ATTENDANCE_SESSION"),
        ("delegation_id", "DELEGATION"),
        ("request_id", "STUDENT_ATTENDANCE_REQUEST"),
        ("class_section_id", "CLASS_SECTION"),
        ("section_id", "CLASS_SECTION"),
        ("department_id", "DEPARTMENT"),
        ("campus_id", "CAMPUS"),
        ("student_id", "STUDENT"),
        ("student_user_id", "STUDENT"),
    ]:
        if param_name in path_params:
            try:
                return res_type, uuid.UUID(str(path_params[param_name]))
            except (ValueError, TypeError):
                return res_type, None

    return None, None


def require_permission(
    permission_code: str,
    resource_type: Optional[str] = None,
    resource_param: Optional[str] = None,
) -> Callable:
    """Authoritative IAC v1 dependency guard evaluating permissions via AuthorizationEvaluator."""
    canonical_permission = LEGACY_PERMISSION_MAP.get(permission_code, permission_code)

    async def permission_checker(
        request: Request,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db_session),
    ) -> User:
        inst_id, membership = await resolve_tenant_and_membership(request, current_user, db)
        await ensure_legacy_role_mapping(current_user, membership, db)

        res_type, res_id = extract_target_resource(request, resource_type, resource_param)

        evaluator = AuthorizationEvaluator(db)
        decision = await evaluator.evaluate(
            actor_user_id=current_user.id,
            permission_code=canonical_permission,
            institution_id=inst_id,
            resource_type=res_type,
            resource_id=res_id,
        )

        if not decision.allowed:
            audit = AuthorizationAudit(
                actor_user_id=current_user.id,
                actor_membership_id=membership.id,
                institution_id=inst_id,
                action=permission_code,
                permission_code=canonical_permission,
                target_resource_type=res_type,
                target_resource_id=str(res_id) if res_id else None,
                outcome=AuditOutcome.DENIED,
                reason=decision.reason,
            )
            db.add(audit)
            await db.flush()

            raise UnauthorizedRoleError(
                f"Action requires permission '{permission_code}': {decision.reason}"
            )

        return current_user

    return permission_checker


def require_roles(*allowed_roles: UserRole) -> Callable:
    """Dependency factory restricting endpoint access to specific institutional roles with shadow evaluation."""

    async def role_checker(
        request: Request,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db_session),
    ) -> User:
        legacy_allowed = (current_user.role in allowed_roles)

        if not legacy_allowed and (UserRole.ADMIN in allowed_roles or UserRole.FACULTY in allowed_roles):
            from datetime import datetime, timezone
            from src.api.v1.auth import ADMIN_ROLE_CODES, FACULTY_ROLE_CODES
            now = datetime.now(timezone.utc)
            ra_stmt = (
                select(RoleTemplate.code)
                .join(RoleAssignment, RoleAssignment.role_template_id == RoleTemplate.id)
                .join(InstitutionMembership, RoleAssignment.membership_id == InstitutionMembership.id)
                .where(
                    InstitutionMembership.user_id == current_user.id,
                    RoleAssignment.status == AssignmentStatus.ACTIVE,
                    RoleAssignment.valid_from <= now,
                    or_(RoleAssignment.valid_until.is_(None), RoleAssignment.valid_until > now),
                    RoleTemplate.is_active.is_(True),
                )
            )
            codes = set((await db.execute(ra_stmt)).scalars().all())
            if UserRole.ADMIN in allowed_roles and (codes & ADMIN_ROLE_CODES or "DEPARTMENT_HEAD" in codes or "DEPARTMENT_HEAD_COORDINATOR" in codes):
                legacy_allowed = True
            elif UserRole.FACULTY in allowed_roles and (codes & FACULTY_ROLE_CODES):
                legacy_allowed = True

        # Feature-flagged shadow evaluation hook
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
                    mem_stmt = select(InstitutionMembership.institution_id).where(
                        InstitutionMembership.user_id == current_user.id,
                        InstitutionMembership.status == MembershipStatus.ACTIVE,
                    )
                    active_inst_ids = (await db.execute(mem_stmt)).scalars().all()
                    if len(active_inst_ids) == 1:
                        active_inst_id = active_inst_ids[0]

                if not active_inst_id:
                    shadow.record_skipped_evaluation(
                        actor_user_id=current_user.id,
                        skip_reason="NO_TENANT_CONTEXT",
                        legacy_allowed=legacy_allowed,
                        correlation_id=cid,
                    )
                else:
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

                    if has_resource_param and not resource_id:
                        shadow.record_skipped_evaluation(
                            actor_user_id=current_user.id,
                            skip_reason="NO_RESOURCE_CONTEXT",
                            legacy_allowed=legacy_allowed,
                            correlation_id=cid,
                            institution_id=active_inst_id,
                            permission_code=shadow_perm,
                        )
                    elif has_resource_param and target_resource_institution_id != active_inst_id:
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


# Convenient legacy role dependency shortcuts
require_admin = require_roles(UserRole.ADMIN)
require_faculty = require_roles(UserRole.FACULTY)
require_student = require_roles(UserRole.STUDENT)
require_faculty_or_admin = require_roles(UserRole.FACULTY, UserRole.ADMIN)
