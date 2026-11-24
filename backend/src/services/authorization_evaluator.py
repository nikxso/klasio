"""Standalone Read-Only Authorization Evaluator for Institutional Access Control v1.

Evaluates:
- Permission codes
- Institution membership status
- Active, time-bounded role assignments (exclusive upper bound: valid_from <= now < valid_until)
- Resource scoping (INSTITUTION, CAMPUS, DEPARTMENT, ACADEMIC_TERM, CLASS_SECTION, TEACHING_ASSIGNMENT, STUDENT)
- Cross-institution resource rejection
- Active delegations, permitted permissions, and scope containment
- Controllable clock for deterministic verification

Guarantees:
- Purely read-only: does not modify, insert, or delete any database records.
- Does not grant permissions via legacy UserRole strings.
- Preserves backfilled users without implicit promotions.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
import uuid
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.user import User, AccountStatus
from src.models.academic import Department, AcademicTerm, ClassSection, Subject
from src.models.assignment import TeachingAssignment
from src.models.enrollment import StudentEnrollment
from src.models.access_control import (
    Institution,
    InstitutionStatus,
    Campus,
    department_campuses,
    InstitutionMembership,
    MembershipStatus,
    RoleTemplate,
    Permission,
    role_permissions,
    RoleAssignment,
    AssignmentStatus,
    RoleScopeType,
    RoleAssignmentScope,
    Delegation,
    DelegationType,
    DelegationLifecycleStatus,
    delegation_permissions,
    DelegationScope,
)


LEGACY_PERMISSION_MAP: Dict[str, str] = {
    "attendance:scan": "attendance.session.start",
    "attendance:finalize": "attendance.session.finalize",
    "attendance:view": "attendance.session.view",
    "attendance:create": "attendance.session.create",
    "attendance:cancel": "attendance.session.cancel",
    "attendance:mark": "attendance.mark.manual",
    "attendance:amend": "attendance.amendment.request",
    "attendance:amend:approve": "attendance.amendment.approve",
    "reports:view": "reports.view",
    "reports:export": "reports.export",
    "biometrics:enroll": "biometrics.enroll.assisted",
    "biometrics:enroll:self": "biometrics.enroll.self",
    "biometrics:status": "biometrics.status.view",
    "biometrics:template:read": "biometrics.template.read",
    "delegation:create": "delegation.create",
    "delegation:approve": "delegation.approve",
    "delegation:revoke": "delegation.revoke",
}


@dataclass(frozen=True)
class AuthorizationDecision:
    allowed: bool
    reason_code: str
    reason: str
    actor_user_id: uuid.UUID
    institution_id: uuid.UUID
    permission_code: str
    resource_type: Optional[str] = None
    resource_id: Optional[uuid.UUID] = None
    membership_id: Optional[uuid.UUID] = None
    role_assignment_id: Optional[uuid.UUID] = None
    delegation_id: Optional[uuid.UUID] = None
    eval_time: Optional[datetime] = None


class AuthorizationEvaluator:
    """Read-only authorization evaluation service."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def evaluate(
        self,
        actor_user_id: uuid.UUID,
        permission_code: str,
        institution_id: uuid.UUID,
        resource_type: Optional[str] = None,
        resource_id: Optional[uuid.UUID] = None,
        context: Optional[Dict[str, Any]] = None,
        clock_now: Optional[datetime] = None,
    ) -> AuthorizationDecision:
        """Evaluate authorization without mutating database state."""
        now = clock_now or datetime.now(timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)

        # 0. Biometric Privacy Non-Disclosure Gate
        # Strictly prohibit direct template/vector access for all human accounts
        if permission_code in ("biometrics.template.read", "biometrics:template:read"):
            return AuthorizationDecision(
                allowed=False,
                reason_code="BIOMETRIC_VECTOR_ACCESS_PROHIBITED",
                reason="Direct vector or biometric template access is strictly prohibited for all human accounts",
                actor_user_id=actor_user_id,
                institution_id=institution_id,
                permission_code=permission_code,
                resource_type=resource_type,
                resource_id=resource_id,
                eval_time=now,
            )

        effective_permission = LEGACY_PERMISSION_MAP.get(permission_code, permission_code)

        # 1. Verify User existence & active account status
        user_stmt = select(User).where(User.id == actor_user_id)
        user_res = await self.db.execute(user_stmt)
        user = user_res.scalar_one_or_none()
        if not user:
            return AuthorizationDecision(
                allowed=False,
                reason_code="USER_NOT_FOUND",
                reason=f"User '{actor_user_id}' does not exist",
                actor_user_id=actor_user_id,
                institution_id=institution_id,
                permission_code=permission_code,
                resource_type=resource_type,
                resource_id=resource_id,
                eval_time=now,
            )
        if user.account_status != AccountStatus.ACTIVE:
            return AuthorizationDecision(
                allowed=False,
                reason_code="USER_INACTIVE",
                reason=f"User account '{user.institutional_id}' is not ACTIVE (status={user.account_status})",
                actor_user_id=actor_user_id,
                institution_id=institution_id,
                permission_code=permission_code,
                resource_type=resource_type,
                resource_id=resource_id,
                eval_time=now,
            )

        # 2. Verify Institution existence & active status
        inst_stmt = select(Institution).where(Institution.id == institution_id)
        inst_res = await self.db.execute(inst_stmt)
        institution = inst_res.scalar_one_or_none()
        if not institution:
            return AuthorizationDecision(
                allowed=False,
                reason_code="INSTITUTION_NOT_FOUND",
                reason=f"Institution '{institution_id}' does not exist",
                actor_user_id=actor_user_id,
                institution_id=institution_id,
                permission_code=permission_code,
                resource_type=resource_type,
                resource_id=resource_id,
                eval_time=now,
            )
        if institution.status != InstitutionStatus.ACTIVE:
            return AuthorizationDecision(
                allowed=False,
                reason_code="INSTITUTION_INACTIVE",
                reason=f"Institution '{institution.code}' is not ACTIVE (status={institution.status})",
                actor_user_id=actor_user_id,
                institution_id=institution_id,
                permission_code=permission_code,
                resource_type=resource_type,
                resource_id=resource_id,
                eval_time=now,
            )

        # 3. Verify User's Membership in this Institution
        member_stmt = select(InstitutionMembership).where(
            and_(
                InstitutionMembership.institution_id == institution_id,
                InstitutionMembership.user_id == actor_user_id,
            )
        )
        member_res = await self.db.execute(member_stmt)
        membership = member_res.scalar_one_or_none()
        if not membership:
            return AuthorizationDecision(
                allowed=False,
                reason_code="MEMBERSHIP_NOT_FOUND",
                reason=f"User has no membership in institution '{institution.code}'",
                actor_user_id=actor_user_id,
                institution_id=institution_id,
                permission_code=permission_code,
                resource_type=resource_type,
                resource_id=resource_id,
                eval_time=now,
            )
        if membership.status != MembershipStatus.ACTIVE:
            return AuthorizationDecision(
                allowed=False,
                reason_code="MEMBERSHIP_INACTIVE",
                reason=f"User membership in institution '{institution.code}' is not ACTIVE (status={membership.status})",
                actor_user_id=actor_user_id,
                institution_id=institution_id,
                permission_code=permission_code,
                resource_type=resource_type,
                resource_id=resource_id,
                membership_id=membership.id,
                eval_time=now,
            )

        # 4. Target Resource Institution Verification (Reject Cross-Institution Target Resources)
        if resource_type and resource_id:
            res_valid, res_err = await self._verify_resource_institution(resource_type, resource_id, institution_id)
            if not res_valid:
                return AuthorizationDecision(
                    allowed=False,
                    reason_code="CROSS_INSTITUTION_RESOURCE",
                    reason=res_err or f"Resource '{resource_type}:{resource_id}' does not belong to institution '{institution.code}'",
                    actor_user_id=actor_user_id,
                    institution_id=institution_id,
                    permission_code=permission_code,
                    resource_type=resource_type,
                    resource_id=resource_id,
                    membership_id=membership.id,
                    eval_time=now,
                )

        # 5. Direct Role Assignments Evaluation
        # Retrieve all active role assignments granting the permission for this membership
        direct_stmt = (
            select(RoleAssignment)
            .join(RoleTemplate, RoleAssignment.role_template_id == RoleTemplate.id)
            .join(role_permissions, RoleTemplate.id == role_permissions.c.role_template_id)
            .join(Permission, role_permissions.c.permission_id == Permission.id)
            .where(
                and_(
                    RoleAssignment.membership_id == membership.id,
                    RoleAssignment.institution_id == institution_id,
                    RoleAssignment.status == AssignmentStatus.ACTIVE,
                    or_(
                        Permission.code == permission_code,
                        Permission.code == effective_permission,
                    ),
                    RoleAssignment.valid_from <= now,
                    or_(
                        RoleAssignment.valid_until.is_(None),
                        RoleAssignment.valid_until > now,  # Exclusive upper bound
                    ),
                )
            )
        )
        direct_assignments = (await self.db.execute(direct_stmt)).scalars().all()

        saw_permission = False
        saw_scope_mismatch = False

        for assignment in direct_assignments:
            saw_permission = True
            is_scoped, scope_reason = await self._check_assignment_scope(assignment.id, resource_type, resource_id, institution_id)
            if is_scoped:
                return AuthorizationDecision(
                    allowed=True,
                    reason_code="ALLOWED",
                    reason="Authorized via direct role assignment",
                    actor_user_id=actor_user_id,
                    institution_id=institution_id,
                    permission_code=permission_code,
                    resource_type=resource_type,
                    resource_id=resource_id,
                    membership_id=membership.id,
                    role_assignment_id=assignment.id,
                    eval_time=now,
                )
            else:
                saw_scope_mismatch = True

        # 6. Delegation Evaluation
        # If not authorized directly, check if a valid delegation grants this permission
        deleg_stmt = (
            select(Delegation)
            .join(delegation_permissions, Delegation.id == delegation_permissions.c.delegation_id)
            .join(Permission, delegation_permissions.c.permission_id == Permission.id)
            .where(
                and_(
                    Delegation.grantee_membership_id == membership.id,
                    Delegation.institution_id == institution_id,
                    Delegation.status == DelegationLifecycleStatus.ACTIVE,
                    or_(
                        Permission.code == permission_code,
                        Permission.code == effective_permission,
                    ),
                    Delegation.valid_from <= now,
                    Delegation.valid_until > now,
                )
            )
        )
        delegations = (await self.db.execute(deleg_stmt)).scalars().all()

        for delegation in delegations:
            # Enforce HoD approval for FACULTY_SUBSTITUTE delegations:
            # Valid ONLY if ACTIVE, approved_by_membership_id and approved_at are present, and within valid window
            if delegation.delegation_type == DelegationType.FACULTY_SUBSTITUTE:
                if (
                    delegation.status != DelegationLifecycleStatus.ACTIVE
                    or delegation.approved_by_membership_id is None
                    or delegation.approved_at is None
                    or not (delegation.valid_from <= now < delegation.valid_until)
                ):
                    continue

            # Grantor assignment must also be active, valid, not INSTITUTION_OWNER, and belonging to an ACTIVE member
            grantor_stmt = (
                select(RoleAssignment)
                .join(RoleTemplate, RoleAssignment.role_template_id == RoleTemplate.id)
                .join(InstitutionMembership, RoleAssignment.membership_id == InstitutionMembership.id)
                .join(role_permissions, RoleTemplate.id == role_permissions.c.role_template_id)
                .join(Permission, role_permissions.c.permission_id == Permission.id)
                .where(
                    and_(
                        RoleAssignment.id == delegation.grantor_role_assignment_id,
                        RoleAssignment.institution_id == institution_id,
                        RoleAssignment.status == AssignmentStatus.ACTIVE,
                        InstitutionMembership.status == MembershipStatus.ACTIVE,
                        RoleTemplate.code != "INSTITUTION_OWNER",
                        or_(
                            Permission.code == permission_code,
                            Permission.code == effective_permission,
                        ),
                        RoleAssignment.valid_from <= now,
                        or_(
                            RoleAssignment.valid_until.is_(None),
                            RoleAssignment.valid_until > now,
                        ),
                    )
                )
            )
            grantor_res = await self.db.execute(grantor_stmt)
            grantor_assignment = grantor_res.scalar_one_or_none()
            if not grantor_assignment:
                continue

            # Grantor assignment scope must contain the resource
            grantor_scoped, _ = await self._check_assignment_scope(grantor_assignment.id, resource_type, resource_id, institution_id)
            if not grantor_scoped:
                continue

            # Delegation scopes must also cover the resource
            deleg_scoped, _ = await self._check_delegation_scope(delegation.id, resource_type, resource_id, institution_id)
            if deleg_scoped:
                return AuthorizationDecision(
                    allowed=True,
                    reason_code="ALLOWED",
                    reason="Authorized via valid delegation",
                    actor_user_id=actor_user_id,
                    institution_id=institution_id,
                    permission_code=permission_code,
                    resource_type=resource_type,
                    resource_id=resource_id,
                    membership_id=membership.id,
                    delegation_id=delegation.id,
                    eval_time=now,
                )
            else:
                saw_scope_mismatch = True

        # Check for expired/inactive assignments if no active assignment matched
        if not saw_permission:
            # Check if assignment existed but expired or inactive
            expired_stmt = (
                select(RoleAssignment)
                .join(RoleTemplate, RoleAssignment.role_template_id == RoleTemplate.id)
                .join(role_permissions, RoleTemplate.id == role_permissions.c.role_template_id)
                .join(Permission, role_permissions.c.permission_id == Permission.id)
                .where(
                    and_(
                        RoleAssignment.membership_id == membership.id,
                        RoleAssignment.institution_id == institution_id,
                        or_(
                            Permission.code == permission_code,
                            Permission.code == effective_permission,
                        ),
                    )
                )
            )
            expired_res = await self.db.execute(expired_stmt)
            inactive_assignments = expired_res.scalars().all()
            if inactive_assignments:
                any_expired = any(a.valid_until and a.valid_until <= now for a in inactive_assignments)
                if any_expired:
                    return AuthorizationDecision(
                        allowed=False,
                        reason_code="ASSIGNMENT_EXPIRED",
                        reason=f"Role assignment granting '{permission_code}' has expired",
                        actor_user_id=actor_user_id,
                        institution_id=institution_id,
                        permission_code=permission_code,
                        resource_type=resource_type,
                        resource_id=resource_id,
                        membership_id=membership.id,
                        eval_time=now,
                    )
                return AuthorizationDecision(
                    allowed=False,
                    reason_code="ASSIGNMENT_INACTIVE",
                    reason=f"Role assignment granting '{permission_code}' is inactive",
                    actor_user_id=actor_user_id,
                    institution_id=institution_id,
                    permission_code=permission_code,
                    resource_type=resource_type,
                    resource_id=resource_id,
                    membership_id=membership.id,
                    eval_time=now,
                )

        if saw_scope_mismatch:
            return AuthorizationDecision(
                allowed=False,
                reason_code="SCOPE_MISMATCH",
                reason=f"Actor holds permission '{permission_code}', but assigned scopes do not cover resource '{resource_type}:{resource_id}'",
                actor_user_id=actor_user_id,
                institution_id=institution_id,
                permission_code=permission_code,
                resource_type=resource_type,
                resource_id=resource_id,
                membership_id=membership.id,
                eval_time=now,
            )

        return AuthorizationDecision(
            allowed=False,
            reason_code="PERMISSION_NOT_ASSIGNED",
            reason=f"Actor does not possess permission '{permission_code}' in institution '{institution.code}'",
            actor_user_id=actor_user_id,
            institution_id=institution_id,
            permission_code=permission_code,
            resource_type=resource_type,
            resource_id=resource_id,
            membership_id=membership.id,
            eval_time=now,
        )

    async def _verify_resource_institution(
        self,
        resource_type: str,
        resource_id: uuid.UUID,
        institution_id: uuid.UUID,
    ) -> tuple[bool, Optional[str]]:
        """Verify that the target resource belongs to the evaluated institution."""
        rtype = resource_type.upper()
        if rtype == "CAMPUS":
            c = (await self.db.execute(select(Campus).where(Campus.id == resource_id))).scalar_one_or_none()
            if not c or c.institution_id != institution_id:
                return False, f"Campus '{resource_id}' does not belong to institution '{institution_id}'"
        elif rtype == "DEPARTMENT":
            d = (await self.db.execute(select(Department).where(Department.id == resource_id))).scalar_one_or_none()
            if not d or d.institution_id != institution_id:
                return False, f"Department '{resource_id}' does not belong to institution '{institution_id}'"
        elif rtype == "ACADEMIC_TERM":
            t = (await self.db.execute(select(AcademicTerm).where(AcademicTerm.id == resource_id))).scalar_one_or_none()
            if not t or t.institution_id != institution_id:
                return False, f"AcademicTerm '{resource_id}' does not belong to institution '{institution_id}'"
        elif rtype == "CLASS_SECTION":
            s = (await self.db.execute(select(ClassSection).where(ClassSection.id == resource_id))).scalar_one_or_none()
            if not s or s.institution_id != institution_id:
                return False, f"ClassSection '{resource_id}' does not belong to institution '{institution_id}'"
        elif rtype == "TEACHING_ASSIGNMENT":
            inst_id = (await self.db.execute(
                select(ClassSection.institution_id)
                .join(TeachingAssignment, TeachingAssignment.class_section_id == ClassSection.id)
                .where(TeachingAssignment.id == resource_id)
            )).scalar_one_or_none()
            if not inst_id or inst_id != institution_id:
                return False, f"TeachingAssignment '{resource_id}' does not belong to institution '{institution_id}'"
        elif rtype == "STUDENT":
            m = (await self.db.execute(
                select(InstitutionMembership).where(
                    and_(
                        InstitutionMembership.user_id == resource_id,
                        InstitutionMembership.institution_id == institution_id,
                        InstitutionMembership.status == MembershipStatus.ACTIVE,
                    )
                )
            )).scalar_one_or_none()
            if not m:
                return False, f"Student user '{resource_id}' is not an active member of institution '{institution_id}'"
        return True, None

    async def _check_assignment_scope(
        self,
        role_assignment_id: uuid.UUID,
        resource_type: Optional[str],
        resource_id: Optional[uuid.UUID],
        institution_id: uuid.UUID,
    ) -> tuple[bool, Optional[str]]:
        """Verify whether at least one scope of the assignment covers the target resource."""
        scopes_stmt = select(RoleAssignmentScope).where(
            RoleAssignmentScope.role_assignment_id == role_assignment_id
        )
        scopes = (await self.db.execute(scopes_stmt)).scalars().all()
        if not scopes:
            # An assignment without explicit scopes grants no resource access
            return False, "Role assignment has no assigned scopes"

        # If operation is general institutional-level without a target resource
        if not resource_type or not resource_id:
            for s in scopes:
                if s.scope_type == RoleScopeType.INSTITUTION:
                    return True, None
            return False, "Institutional-level operation requires INSTITUTION scope"

        rtype = resource_type.upper()

        for s in scopes:
            # 1. INSTITUTION scope covers all descendant resources within the institution
            if s.scope_type == RoleScopeType.INSTITUTION:
                return True, None

            # 2. CAMPUS scope
            if s.scope_type == RoleScopeType.CAMPUS:
                if rtype == "CAMPUS" and s.campus_id == resource_id:
                    return True, None
                if rtype == "CLASS_SECTION":
                    sec = (await self.db.execute(select(ClassSection).where(ClassSection.id == resource_id))).scalar_one_or_none()
                    if sec and sec.campus_id == s.campus_id:
                        return True, None
                if rtype == "TEACHING_ASSIGNMENT":
                    ta_campus_id = (await self.db.execute(
                        select(ClassSection.campus_id)
                        .join(TeachingAssignment, TeachingAssignment.class_section_id == ClassSection.id)
                        .where(TeachingAssignment.id == resource_id)
                    )).scalar_one_or_none()
                    if ta_campus_id == s.campus_id:
                        return True, None

            # 3. DEPARTMENT scope
            if s.scope_type == RoleScopeType.DEPARTMENT:
                if rtype == "DEPARTMENT" and s.department_id == resource_id:
                    return True, None
                if rtype == "CLASS_SECTION":
                    sec = (await self.db.execute(select(ClassSection).where(ClassSection.id == resource_id))).scalar_one_or_none()
                    if sec and sec.department_id == s.department_id:
                        return True, None
                if rtype == "TEACHING_ASSIGNMENT":
                    ta_dept_id = (await self.db.execute(
                        select(ClassSection.department_id)
                        .join(TeachingAssignment, TeachingAssignment.class_section_id == ClassSection.id)
                        .where(TeachingAssignment.id == resource_id)
                    )).scalar_one_or_none()
                    if ta_dept_id == s.department_id:
                        return True, None

            # 4. ACADEMIC_TERM scope
            if s.scope_type == RoleScopeType.ACADEMIC_TERM:
                if rtype == "ACADEMIC_TERM" and s.academic_term_id == resource_id:
                    return True, None
                if rtype == "CLASS_SECTION":
                    sec = (await self.db.execute(select(ClassSection).where(ClassSection.id == resource_id))).scalar_one_or_none()
                    if sec and sec.academic_term_id == s.academic_term_id:
                        return True, None

            # 5. CLASS_SECTION scope
            if s.scope_type == RoleScopeType.CLASS_SECTION:
                if rtype == "CLASS_SECTION" and s.class_section_id == resource_id:
                    return True, None
                if rtype == "TEACHING_ASSIGNMENT":
                    sec_id = (await self.db.execute(
                        select(TeachingAssignment.class_section_id).where(TeachingAssignment.id == resource_id)
                    )).scalar_one_or_none()
                    if sec_id == s.class_section_id:
                        return True, None
                if rtype == "STUDENT":
                    # Covered if student is enrolled in this section
                    enr = (await self.db.execute(
                        select(StudentEnrollment).where(
                            and_(
                                StudentEnrollment.class_section_id == s.class_section_id,
                                StudentEnrollment.student_user_id == resource_id,
                            )
                        )
                    )).scalar_one_or_none()
                    if enr:
                        return True, None

            # 6. TEACHING_ASSIGNMENT scope
            if s.scope_type == RoleScopeType.TEACHING_ASSIGNMENT:
                if rtype == "TEACHING_ASSIGNMENT" and s.teaching_assignment_id == resource_id:
                    return True, None

            # 7. STUDENT scope
            if s.scope_type == RoleScopeType.STUDENT:
                if rtype == "STUDENT" and s.student_user_id == resource_id:
                    return True, None

        return False, "Target resource is not contained within assigned scopes"

    async def _check_delegation_scope(
        self,
        delegation_id: uuid.UUID,
        resource_type: Optional[str],
        resource_id: Optional[uuid.UUID],
        institution_id: uuid.UUID,
    ) -> tuple[bool, Optional[str]]:
        """Verify whether at least one scope of the delegation covers the target resource."""
        scopes_stmt = select(DelegationScope).where(
            DelegationScope.delegation_id == delegation_id
        )
        scopes = (await self.db.execute(scopes_stmt)).scalars().all()
        if not scopes:
            # If no explicit delegation scopes are configured, inherits grantor's assignment scope
            return True, None

        if not resource_type or not resource_id:
            for s in scopes:
                if s.scope_type == RoleScopeType.INSTITUTION:
                    return True, None
            return False, "Delegated operation requires INSTITUTION delegation scope"

        rtype = resource_type.upper()
        for s in scopes:
            if s.scope_type == RoleScopeType.INSTITUTION:
                return True, None
            if s.scope_type == RoleScopeType.CAMPUS:
                if rtype == "CAMPUS" and s.campus_id == resource_id:
                    return True, None
                if rtype == "CLASS_SECTION":
                    sec_campus_id = (await self.db.execute(select(ClassSection.campus_id).where(ClassSection.id == resource_id))).scalar_one_or_none()
                    if sec_campus_id == s.campus_id:
                        return True, None
                if rtype == "TEACHING_ASSIGNMENT":
                    ta_campus_id = (await self.db.execute(
                        select(ClassSection.campus_id)
                        .join(TeachingAssignment, TeachingAssignment.class_section_id == ClassSection.id)
                        .where(TeachingAssignment.id == resource_id)
                    )).scalar_one_or_none()
                    if ta_campus_id == s.campus_id:
                        return True, None
            if s.scope_type == RoleScopeType.DEPARTMENT:
                if rtype == "DEPARTMENT" and s.department_id == resource_id:
                    return True, None
                if rtype == "CLASS_SECTION":
                    sec_dept_id = (await self.db.execute(select(ClassSection.department_id).where(ClassSection.id == resource_id))).scalar_one_or_none()
                    if sec_dept_id == s.department_id:
                        return True, None
                if rtype == "TEACHING_ASSIGNMENT":
                    ta_dept_id = (await self.db.execute(
                        select(ClassSection.department_id)
                        .join(TeachingAssignment, TeachingAssignment.class_section_id == ClassSection.id)
                        .where(TeachingAssignment.id == resource_id)
                    )).scalar_one_or_none()
                    if ta_dept_id == s.department_id:
                        return True, None
            if s.scope_type == RoleScopeType.CLASS_SECTION:
                if rtype == "CLASS_SECTION" and s.class_section_id == resource_id:
                    return True, None
                if rtype == "TEACHING_ASSIGNMENT":
                    sec_id = (await self.db.execute(
                        select(TeachingAssignment.class_section_id).where(TeachingAssignment.id == resource_id)
                    )).scalar_one_or_none()
                    if sec_id == s.class_section_id:
                        return True, None
            if s.scope_type == RoleScopeType.TEACHING_ASSIGNMENT and rtype == "TEACHING_ASSIGNMENT" and s.teaching_assignment_id == resource_id:
                return True, None
            if s.scope_type == RoleScopeType.STUDENT and rtype == "STUDENT" and s.student_user_id == resource_id:
                return True, None

        return False, "Target resource is not contained within delegation scopes"
