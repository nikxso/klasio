"""Comprehensive Tests for AuthorizationEvaluator and ShadowAuthorizationEvaluator.

Verifies:
- Stable permission code evaluation
- Status checks across User, Membership, and Assignment
- Controllable clock and exclusive expiration boundaries
- Resource scoping and scope containment
- Cross-institution target resource rejection
- Active delegations and grantor scope containment
- Read-only guarantees
- Preservation of backfilled users (denied without assignments)
- Non-granting of permissions via legacy UserRole field
- Shadow evaluation comparison and structured observation categorization
"""
from datetime import datetime, date, timezone, timedelta
import uuid
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.user import User, UserRole, AccountStatus
from src.models.academic import Department, AcademicTerm, ClassSection, TermStatus
from src.models.access_control import (
    Institution,
    InstitutionStatus,
    Campus,
    InstitutionMembership,
    MembershipStatus,
    RoleTemplate,
    RoleAssignment,
    AssignmentStatus,
    RoleScopeType,
    RoleAssignmentScope,
    Delegation,
    DelegationLifecycleStatus,
    DelegationScope,
    Permission,
    role_permissions,
    delegation_permissions,
)
from scripts.seed_access_control import seed_access_control_catalog
from src.services.authorization_evaluator import AuthorizationEvaluator, AuthorizationDecision
from src.services.shadow_evaluator import ShadowAuthorizationEvaluator, ShadowObservation


@pytest.mark.asyncio
async def test_evaluator_unassigned_backfilled_user_denied(db_session: AsyncSession):
    """Backfilled users with ACTIVE membership but no role assignments are denied by the evaluator."""
    await seed_access_control_catalog(db_session)

    inst = Institution(code=f"INST_BACKFILL_{uuid.uuid4().hex[:6]}", name="Backfill Inst")
    user = User(
        institutional_id=f"U_BACK_{uuid.uuid4().hex[:6]}",
        email=f"back_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Backfilled User",
        role=UserRole.ADMIN,  # Legacy role exists, but NO role assignment!
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, user])
    await db_session.flush()

    membership = InstitutionMembership(
        institution_id=inst.id,
        user_id=user.id,
        status=MembershipStatus.ACTIVE,
    )
    db_session.add(membership)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    decision = await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="institution.manage",
        institution_id=inst.id,
    )

    assert decision.allowed is False
    assert decision.reason_code == "PERMISSION_NOT_ASSIGNED"
    assert "does not possess permission" in decision.reason


@pytest.mark.asyncio
async def test_evaluator_clock_exclusive_upper_bound(db_session: AsyncSession):
    """Test controllable clock and exclusive validity expiration: valid_from <= now < valid_until."""
    await seed_access_control_catalog(db_session)

    inst = Institution(code=f"INST_CLOCK_{uuid.uuid4().hex[:6]}", name="Clock Inst")
    user = User(
        institutional_id=f"U_CLOCK_{uuid.uuid4().hex[:6]}",
        email=f"clock_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Clock User",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, user])
    await db_session.flush()

    membership = InstitutionMembership(institution_id=inst.id, user_id=user.id, status=MembershipStatus.ACTIVE)
    db_session.add(membership)
    await db_session.flush()

    faculty_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()

    t_start = datetime(2026, 11, 1, 10, 0, 0, tzinfo=timezone.utc)
    t_end = datetime(2026, 11, 1, 12, 0, 0, tzinfo=timezone.utc)

    assignment = RoleAssignment(
        institution_id=inst.id,
        membership_id=membership.id,
        role_template_id=faculty_role.id,
        status=AssignmentStatus.ACTIVE,
        valid_from=t_start,
        valid_until=t_end,
    )
    db_session.add(assignment)
    await db_session.flush()

    scope = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.INSTITUTION,
    )
    db_session.add(scope)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)

    # 1. Before valid_from: Denied
    d_before = await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        clock_now=t_start - timedelta(seconds=1),
    )
    assert d_before.allowed is False
    assert d_before.reason_code in ("ASSIGNMENT_INACTIVE", "PERMISSION_NOT_ASSIGNED")

    # 2. Exactly at valid_from: Allowed (inclusive start)
    d_start = await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        clock_now=t_start,
    )
    assert d_start.allowed is True
    assert d_start.reason_code == "ALLOWED"

    # 3. Mid-window: Allowed
    d_mid = await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        clock_now=t_start + timedelta(minutes=30),
    )
    assert d_mid.allowed is True

    # 4. Exactly at valid_until: Denied (exclusive upper bound!)
    d_end = await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        clock_now=t_end,
    )
    assert d_end.allowed is False
    assert d_end.reason_code == "ASSIGNMENT_EXPIRED"

    # 5. After valid_until: Denied (expired)
    d_after = await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        clock_now=t_end + timedelta(minutes=5),
    )
    assert d_after.allowed is False
    assert d_after.reason_code == "ASSIGNMENT_EXPIRED"


@pytest.mark.asyncio
async def test_evaluator_rejects_cross_institution_target_resource(db_session: AsyncSession):
    """Evaluator rejects any request targeting a resource that belongs to another institution."""
    await seed_access_control_catalog(db_session)

    inst_a = Institution(code=f"IA_CROSS_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_CROSS_{uuid.uuid4().hex[:6]}", name="Inst B")
    user = User(
        institutional_id=f"U_CROSS_{uuid.uuid4().hex[:6]}",
        email=f"cross_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Cross User",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst_a, inst_b, user])
    await db_session.flush()

    # User has membership and full INSTITUTION scope in Inst A
    m_a = InstitutionMembership(institution_id=inst_a.id, user_id=user.id, status=MembershipStatus.ACTIVE)
    owner_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "INSTITUTION_OWNER"))).scalar_one()
    db_session.add(m_a)
    await db_session.flush()

    assignment = RoleAssignment(
        institution_id=inst_a.id,
        membership_id=m_a.id,
        role_template_id=owner_role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assignment)
    await db_session.flush()

    scope = RoleAssignmentScope(role_assignment_id=assignment.id, institution_id=inst_a.id, scope_type=RoleScopeType.INSTITUTION)
    db_session.add(scope)

    # Department B belongs to Inst B
    dept_b = Department(institution_id=inst_b.id, code=f"DB_{uuid.uuid4().hex[:6]}", name="Dept B")
    db_session.add(dept_b)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    decision = await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="academic_structure.view",
        institution_id=inst_a.id,
        resource_type="DEPARTMENT",
        resource_id=dept_b.id,
    )

    assert decision.allowed is False
    assert decision.reason_code == "CROSS_INSTITUTION_RESOURCE"
    assert "does not belong to institution" in decision.reason


@pytest.mark.asyncio
async def test_evaluator_scope_containment_and_mismatch(db_session: AsyncSession):
    """Evaluator checks resource scope containment (Department scope covers only sections in that department)."""
    await seed_access_control_catalog(db_session)

    inst = Institution(code=f"INST_SCOPE_{uuid.uuid4().hex[:6]}", name="Scope Inst")
    user = User(
        institutional_id=f"U_DEPT_{uuid.uuid4().hex[:6]}",
        email=f"dept_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Dept Coord",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, user])
    await db_session.flush()

    campus = Campus(institution_id=inst.id, code="C1", name="Campus 1")
    dept_1 = Department(institution_id=inst.id, code="D1", name="Dept 1")
    dept_2 = Department(institution_id=inst.id, code="D2", name="Dept 2")
    term = AcademicTerm(
        institution_id=inst.id,
        code=f"TERM_{uuid.uuid4().hex[:6]}",
        name="Term 1",
        academic_year="2026-2027",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
    )
    db_session.add_all([campus, dept_1, dept_2, term])
    await db_session.flush()

    sec_1 = ClassSection(institution_id=inst.id, campus_id=campus.id, department_id=dept_1.id, academic_term_id=term.id, section_code="SEC_D1", cohort_year=2024)
    sec_2 = ClassSection(institution_id=inst.id, campus_id=campus.id, department_id=dept_2.id, academic_term_id=term.id, section_code="SEC_D2", cohort_year=2024)
    m = InstitutionMembership(institution_id=inst.id, user_id=user.id, status=MembershipStatus.ACTIVE)
    db_session.add_all([sec_1, sec_2, m])
    await db_session.flush()

    role_coord = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "DEPARTMENT_HEAD_COORDINATOR"))).scalar_one()
    assignment = RoleAssignment(
        institution_id=inst.id,
        membership_id=m.id,
        role_template_id=role_coord.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assignment)
    await db_session.flush()

    # Scope assignment strictly to Dept 1
    scope_d1 = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.DEPARTMENT,
        department_id=dept_1.id,
    )
    db_session.add(scope_d1)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)

    # 1. Section in Dept 1: ALLOWED
    d_sec1 = await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="attendance.session.view",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_1.id,
    )
    assert d_sec1.allowed is True
    assert d_sec1.reason_code == "ALLOWED"

    # 2. Section in Dept 2 (sibling department): DENIED with SCOPE_MISMATCH
    d_sec2 = await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="attendance.session.view",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_2.id,
    )
    assert d_sec2.allowed is False
    assert d_sec2.reason_code == "SCOPE_MISMATCH"


@pytest.mark.asyncio
async def test_evaluator_delegation_success(db_session: AsyncSession):
    """Evaluator allows operation when authorized through an active, valid delegation."""
    await seed_access_control_catalog(db_session)

    inst = Institution(code=f"INST_DELG_EV_{uuid.uuid4().hex[:6]}", name="Delg Inst")
    fac_reg = User(institutional_id=f"F_REG_{uuid.uuid4().hex[:6]}", email=f"reg_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="Regular Fac", role=UserRole.FACULTY)
    fac_sub = User(institutional_id=f"F_SUB_{uuid.uuid4().hex[:6]}", email=f"sub_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="Sub Fac", role=UserRole.FACULTY)
    db_session.add_all([inst, fac_reg, fac_sub])
    await db_session.flush()

    campus = Campus(institution_id=inst.id, code="C1", name="Campus 1")
    dept = Department(institution_id=inst.id, code="D1", name="Dept 1")
    term = AcademicTerm(institution_id=inst.id, code=f"T_{uuid.uuid4().hex[:6]}", name="Term", academic_year="2026", start_date=date(2026, 1, 1), end_date=date(2026, 6, 1))
    db_session.add_all([campus, dept, term])
    await db_session.flush()

    sec = ClassSection(institution_id=inst.id, campus_id=campus.id, department_id=dept.id, academic_term_id=term.id, section_code="SEC_1", cohort_year=2024)
    m_reg = InstitutionMembership(institution_id=inst.id, user_id=fac_reg.id, status=MembershipStatus.ACTIVE)
    m_sub = InstitutionMembership(institution_id=inst.id, user_id=fac_sub.id, status=MembershipStatus.ACTIVE)
    db_session.add_all([sec, m_reg, m_sub])
    await db_session.flush()

    faculty_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    assign_reg = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_reg.id,
        role_template_id=faculty_role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assign_reg)
    await db_session.flush()

    scope_reg = RoleAssignmentScope(
        role_assignment_id=assign_reg.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.CLASS_SECTION,
        class_section_id=sec.id,
    )
    db_session.add(scope_reg)
    await db_session.flush()

    # Delegate attendance.session.start from Regular to Substitute
    now = datetime.now(timezone.utc)
    delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=assign_reg.id,
        grantee_membership_id=m_sub.id,
        status=DelegationLifecycleStatus.ACTIVE,
        approved_by_membership_id=m_reg.id,
        approved_at=now - timedelta(hours=1),
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=2),
        reason="Sick leave coverage",
    )
    db_session.add(delg)
    await db_session.flush()

    perm_start = (await db_session.execute(select(Permission).where(Permission.code == "attendance.session.start"))).scalar_one()
    ins_delg_perm = delegation_permissions.insert().values(delegation_id=delg.id, permission_id=perm_start.id)
    await db_session.execute(ins_delg_perm)

    delg_scope = DelegationScope(
        delegation_id=delg.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.CLASS_SECTION,
        class_section_id=sec.id,
    )
    db_session.add(delg_scope)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)

    # Substitute faculty evaluated for attendance.session.start in sec.id -> ALLOWED via delegation
    d_sub = await evaluator.evaluate(
        actor_user_id=fac_sub.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec.id,
    )
    assert d_sub.allowed is True
    assert d_sub.delegation_id == delg.id
    assert "Authorized via valid delegation" in d_sub.reason


@pytest.mark.asyncio
async def test_shadow_evaluator_observational_telemetry(db_session: AsyncSession):
    """Shadow evaluator records comparisons without altering legacy decision."""
    await seed_access_control_catalog(db_session)

    inst = Institution(code=f"INST_SHADOW_{uuid.uuid4().hex[:6]}", name="Shadow Inst")
    admin_user = User(
        institutional_id=f"ADM_SHAD_{uuid.uuid4().hex[:6]}",
        email=f"shad_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Legacy Admin",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, admin_user])
    await db_session.flush()

    m = InstitutionMembership(institution_id=inst.id, user_id=admin_user.id, status=MembershipStatus.ACTIVE)
    db_session.add(m)
    await db_session.commit()

    shadow = ShadowAuthorizationEvaluator(db_session)

    # 1. Simulate legacy endpoint where legacy check passes (legacy_allowed=True), but user is unassigned in RBAC
    obs1 = await shadow.shadow_evaluate(
        legacy_allowed=True,
        actor_user_id=admin_user.id,
        permission_code="institution.manage",
        institution_id=inst.id,
        actor_institutional_id=admin_user.institutional_id,
        correlation_id="test-cid-101",
    )

    assert obs1.legacy_allowed is True
    assert obs1.new_allowed is False
    assert obs1.matched is False
    assert obs1.is_expected_mismatch is True
    assert obs1.mismatch_category == "UNASSIGNED_LEGACY_USER"
    assert obs1.correlation_id == "test-cid-101"

    # 2. Assign INSTITUTION_OWNER and test matched observation
    owner_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "INSTITUTION_OWNER"))).scalar_one()
    assignment = RoleAssignment(
        institution_id=inst.id,
        membership_id=m.id,
        role_template_id=owner_role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assignment)
    await db_session.flush()

    scope = RoleAssignmentScope(role_assignment_id=assignment.id, institution_id=inst.id, scope_type=RoleScopeType.INSTITUTION)
    db_session.add(scope)
    await db_session.commit()

    obs2 = await shadow.shadow_evaluate(
        legacy_allowed=True,
        actor_user_id=admin_user.id,
        permission_code="institution.manage",
        institution_id=inst.id,
        actor_institutional_id=admin_user.institutional_id,
        correlation_id="test-cid-102",
    )

    assert obs2.legacy_allowed is True
    assert obs2.new_allowed is True
    assert obs2.matched is True
    assert obs2.is_expected_mismatch is False
    assert obs2.mismatch_category is None


@pytest.mark.asyncio
async def test_evaluator_does_not_grant_via_legacy_user_role(db_session: AsyncSession):
    """Evaluator strictly ignores legacy UserRole enum and does not grant permissions without RBAC role templates."""
    await seed_access_control_catalog(db_session)

    inst = Institution(code=f"INST_LEGACY_{uuid.uuid4().hex[:6]}", name="Legacy Role Inst")
    admin_user = User(
        institutional_id=f"ADM_LEG_{uuid.uuid4().hex[:6]}",
        email=f"leg_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Legacy Role Admin",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, admin_user])
    await db_session.flush()

    m = InstitutionMembership(institution_id=inst.id, user_id=admin_user.id, status=MembershipStatus.ACTIVE)
    db_session.add(m)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    for perm in ["institution.view", "institution.manage", "attendance.session.start", "reports.view"]:
        dec = await evaluator.evaluate(
            actor_user_id=admin_user.id,
            permission_code=perm,
            institution_id=inst.id,
        )
        assert dec.allowed is False
        assert dec.reason_code == "PERMISSION_NOT_ASSIGNED"


@pytest.mark.asyncio
async def test_evaluator_strictly_read_only(db_session: AsyncSession):
    """Evaluator does not insert, update, or mark any dirty/new/deleted objects in the session."""
    await seed_access_control_catalog(db_session)

    inst = Institution(code=f"INST_RO_{uuid.uuid4().hex[:6]}", name="ReadOnly Inst")
    user = User(
        institutional_id=f"U_RO_{uuid.uuid4().hex[:6]}",
        email=f"ro_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="ReadOnly User",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, user])
    await db_session.flush()

    m = InstitutionMembership(institution_id=inst.id, user_id=user.id, status=MembershipStatus.ACTIVE)
    db_session.add(m)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    await evaluator.evaluate(
        actor_user_id=user.id,
        permission_code="attendance.session.view",
        institution_id=inst.id,
    )

    # Assert session is completely clean (no pending writes)
    assert len(db_session.new) == 0
    assert len(db_session.dirty) == 0
    assert len(db_session.deleted) == 0

