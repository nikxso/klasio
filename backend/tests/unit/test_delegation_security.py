"""Rigorous Unit Tests for Institutional Access Control v1 Delegation Security Rules.

Verifies all 8 approved delegation security invariants:
1. Grantor must possess the permission being delegated (subset of grantor authority).
2. Delegation scope cannot exceed grantor's permitted scope (scope containment).
3. Delegation is strictly bounded by valid_from <= now < valid_until.
4. Expired or revoked delegations are immediately rejected.
5. Re-delegation is structurally prohibited (grantor must be a RoleAssignment, not a delegation).
6. No privilege escalation: invalidating the grantor's assignment revokes the delegation's validity.
7. INSTITUTION_OWNER authority CANNOT be delegated under any circumstances.
8. Both grantor and grantee must have active membership in the same institution.
"""
from datetime import datetime, date, timezone, timedelta
import uuid
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.user import User, UserRole, AccountStatus
from src.models.academic import Department, AcademicTerm, ClassSection
from src.models.access_control import (
    Institution,
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
    delegation_permissions,
)
from scripts.seed_access_control import seed_access_control_catalog
from src.services.authorization_evaluator import AuthorizationEvaluator


@pytest.fixture(autouse=True)
async def seed_catalog(db_session: AsyncSession):
    await seed_access_control_catalog(db_session)


async def _setup_institution_and_members(db_session: AsyncSession):
    inst = Institution(code=f"INST_DELG_SEC_{uuid.uuid4().hex[:6]}", name="Delegation Sec Inst")
    user_grantor = User(
        institutional_id=f"G_{uuid.uuid4().hex[:6]}",
        email=f"grantor_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Grantor Faculty",
        role=UserRole.FACULTY,
    )
    user_grantee = User(
        institutional_id=f"E_{uuid.uuid4().hex[:6]}",
        email=f"grantee_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Grantee Faculty",
        role=UserRole.FACULTY,
    )
    db_session.add_all([inst, user_grantor, user_grantee])
    await db_session.flush()

    campus = Campus(institution_id=inst.id, code="C1", name="Main Campus")
    dept = Department(institution_id=inst.id, code="D1", name="CS Dept")
    term = AcademicTerm(
        institution_id=inst.id,
        code=f"T_{uuid.uuid4().hex[:6]}",
        name="Term 2026",
        academic_year="2026",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
    )
    db_session.add_all([campus, dept, term])
    await db_session.flush()

    sec_a = ClassSection(
        institution_id=inst.id,
        campus_id=campus.id,
        department_id=dept.id,
        academic_term_id=term.id,
        section_code="SEC_A",
        cohort_year=2024,
    )
    sec_b = ClassSection(
        institution_id=inst.id,
        campus_id=campus.id,
        department_id=dept.id,
        academic_term_id=term.id,
        section_code="SEC_B",
        cohort_year=2024,
    )
    m_grantor = InstitutionMembership(institution_id=inst.id, user_id=user_grantor.id, status=MembershipStatus.ACTIVE)
    m_grantee = InstitutionMembership(institution_id=inst.id, user_id=user_grantee.id, status=MembershipStatus.ACTIVE)
    db_session.add_all([sec_a, sec_b, m_grantor, m_grantee])
    await db_session.flush()

    return {
        "inst": inst,
        "grantor": user_grantor,
        "grantee": user_grantee,
        "m_grantor": m_grantor,
        "m_grantee": m_grantee,
        "sec_a": sec_a,
        "sec_b": sec_b,
    }


@pytest.mark.asyncio
async def test_rule_1_grantor_lacks_permission_rejected(db_session: AsyncSession):
    """Rule 1: Grantor cannot delegate a permission that the grantor does not possess."""
    data = await _setup_institution_and_members(db_session)
    inst, grantor, grantee = data["inst"], data["grantor"], data["grantee"]
    m_grantor, m_grantee, sec_a = data["m_grantor"], data["m_grantee"], data["sec_a"]

    # Grantor has FACULTY role (which has attendance.session.start, but NOT institution.manage)
    fac_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_grantor.id,
        role_template_id=fac_role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assign)
    await db_session.flush()

    # Attempt delegation of institution.manage (which grantor lacks!)
    now = datetime.now(timezone.utc)
    delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=assign.id,
        grantee_membership_id=m_grantee.id,
        status=DelegationLifecycleStatus.ACTIVE,
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=1),
        reason="Test delegation rule 1",
    )
    db_session.add(delg)
    await db_session.flush()

    perm_inst_manage = (await db_session.execute(select(Permission).where(Permission.code == "institution.manage"))).scalar_one()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg.id, permission_id=perm_inst_manage.id))
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    decision = await evaluator.evaluate(
        actor_user_id=grantee.id,
        permission_code="institution.manage",
        institution_id=inst.id,
    )
    assert decision.allowed is False
    assert decision.reason_code == "PERMISSION_NOT_ASSIGNED"


@pytest.mark.asyncio
async def test_rule_2_scope_exceeds_grantor_scope_rejected(db_session: AsyncSession):
    """Rule 2: Grantee cannot exercise delegated authority outside the grantor's permitted scope."""
    data = await _setup_institution_and_members(db_session)
    inst, grantor, grantee = data["inst"], data["grantor"], data["grantee"]
    m_grantor, m_grantee, sec_a, sec_b = data["m_grantor"], data["m_grantee"], data["sec_a"], data["sec_b"]

    fac_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_grantor.id,
        role_template_id=fac_role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assign)
    await db_session.flush()

    # Grantor scope is limited strictly to Section A
    scope_grantor = RoleAssignmentScope(
        role_assignment_id=assign.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.CLASS_SECTION,
        class_section_id=sec_a.id,
    )
    db_session.add(scope_grantor)
    await db_session.flush()

    # Delegation attempts to scope Section B
    now = datetime.now(timezone.utc)
    delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=assign.id,
        grantee_membership_id=m_grantee.id,
        status=DelegationLifecycleStatus.ACTIVE,
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=1),
        reason="Test delegation rule 2",
    )
    db_session.add(delg)
    await db_session.flush()

    perm_start = (await db_session.execute(select(Permission).where(Permission.code == "attendance.session.start"))).scalar_one()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg.id, permission_id=perm_start.id))

    delg_scope = DelegationScope(
        delegation_id=delg.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.CLASS_SECTION,
        class_section_id=sec_b.id,
    )
    db_session.add(delg_scope)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    # Target resource is sec_b: grantor lacks scope over sec_b, so evaluator rejects!
    decision = await evaluator.evaluate(
        actor_user_id=grantee.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_b.id,
    )
    assert decision.allowed is False
    assert decision.reason_code == "PERMISSION_NOT_ASSIGNED"


@pytest.mark.asyncio
async def test_rule_3_clock_exclusive_upper_bound_rejected(db_session: AsyncSession):
    """Rule 3: Delegation is rejected outside validity window (valid_from <= now < valid_until)."""
    data = await _setup_institution_and_members(db_session)
    inst, grantor, grantee = data["inst"], data["grantor"], data["grantee"]
    m_grantor, m_grantee, sec_a = data["m_grantor"], data["m_grantee"], data["sec_a"]

    t_start = datetime(2026, 11, 2, 8, 0, 0, tzinfo=timezone.utc)
    t_end = datetime(2026, 11, 2, 10, 0, 0, tzinfo=timezone.utc)

    fac_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_grantor.id,
        role_template_id=fac_role.id,
        status=AssignmentStatus.ACTIVE,
        valid_from=t_start - timedelta(days=1),
    )
    db_session.add(assign)
    await db_session.flush()

    scope = RoleAssignmentScope(role_assignment_id=assign.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id)
    db_session.add(scope)
    await db_session.flush()

    delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=assign.id,
        grantee_membership_id=m_grantee.id,
        status=DelegationLifecycleStatus.ACTIVE,
        approved_by_membership_id=m_grantor.id,
        approved_at=t_start - timedelta(hours=1),
        valid_from=t_start,
        valid_until=t_end,
        reason="Test delegation rule 3",
    )
    db_session.add(delg)
    await db_session.flush()

    perm_start = (await db_session.execute(select(Permission).where(Permission.code == "attendance.session.start"))).scalar_one()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg.id, permission_id=perm_start.id))
    delg_scope = DelegationScope(delegation_id=delg.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id)
    db_session.add(delg_scope)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)

    # 1. Before valid_from -> Denied
    d_before = await evaluator.evaluate(
        actor_user_id=grantee.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
        clock_now=t_start - timedelta(seconds=1),
    )
    assert d_before.allowed is False

    # 2. Exactly at valid_until -> Denied (exclusive upper bound)
    d_exact_end = await evaluator.evaluate(
        actor_user_id=grantee.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
        clock_now=t_end,
    )
    assert d_exact_end.allowed is False

    # 3. Inside window -> Allowed
    d_inside = await evaluator.evaluate(
        actor_user_id=grantee.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
        clock_now=t_start + timedelta(minutes=30),
    )
    assert d_inside.allowed is True


@pytest.mark.asyncio
async def test_rule_4_expired_or_revoked_status_rejected(db_session: AsyncSession):
    """Rule 4: Expired or Revoked delegations are rejected immediately."""
    data = await _setup_institution_and_members(db_session)
    inst, grantor, grantee = data["inst"], data["grantor"], data["grantee"]
    m_grantor, m_grantee, sec_a = data["m_grantor"], data["m_grantee"], data["sec_a"]

    fac_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_grantor.id,
        role_template_id=fac_role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assign)
    await db_session.flush()

    scope = RoleAssignmentScope(role_assignment_id=assign.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id)
    db_session.add(scope)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    # Set status explicitly to REVOKED
    delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=assign.id,
        grantee_membership_id=m_grantee.id,
        status=DelegationLifecycleStatus.REVOKED,
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=1),
        reason="Revoked delegation",
    )
    db_session.add(delg)
    await db_session.flush()

    perm_start = (await db_session.execute(select(Permission).where(Permission.code == "attendance.session.start"))).scalar_one()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg.id, permission_id=perm_start.id))
    delg_scope = DelegationScope(delegation_id=delg.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id)
    db_session.add(delg_scope)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    decision = await evaluator.evaluate(
        actor_user_id=grantee.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
    )
    assert decision.allowed is False
    assert decision.reason_code == "PERMISSION_NOT_ASSIGNED"


@pytest.mark.asyncio
async def test_rule_5_re_delegation_structurally_impossible(db_session: AsyncSession):
    """Rule 5: Re-delegation is structurally rejected because grantor must be a RoleAssignment."""
    # Attempting to set grantor_role_assignment_id to a non-existent role assignment fails foreign key
    data = await _setup_institution_and_members(db_session)
    inst, grantee, m_grantee = data["inst"], data["grantee"], data["m_grantee"]

    now = datetime.now(timezone.utc)
    invalid_delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=uuid.uuid4(),  # Random ID that is NOT a role assignment
        grantee_membership_id=m_grantee.id,
        status=DelegationLifecycleStatus.ACTIVE,
        valid_from=now,
        valid_until=now + timedelta(days=1),
        reason="Invalid delegation",
    )
    db_session.add(invalid_delg)
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_rule_6_grantor_assignment_inactivation_invalidates_delegation(db_session: AsyncSession):
    """Rule 6: When grantor's role assignment is revoked/inactive, grantee delegation is invalid."""
    data = await _setup_institution_and_members(db_session)
    inst, grantor, grantee = data["inst"], data["grantor"], data["grantee"]
    m_grantor, m_grantee, sec_a = data["m_grantor"], data["m_grantee"], data["sec_a"]

    fac_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    # Grantor assignment is INACTIVE / REVOKED
    assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_grantor.id,
        role_template_id=fac_role.id,
        status=AssignmentStatus.REVOKED,
    )
    db_session.add(assign)
    await db_session.flush()

    scope = RoleAssignmentScope(role_assignment_id=assign.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id)
    db_session.add(scope)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=assign.id,
        grantee_membership_id=m_grantee.id,
        status=DelegationLifecycleStatus.ACTIVE,
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=1),
        reason="Delegation rule 6",
    )
    db_session.add(delg)
    await db_session.flush()

    perm_start = (await db_session.execute(select(Permission).where(Permission.code == "attendance.session.start"))).scalar_one()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg.id, permission_id=perm_start.id))
    delg_scope = DelegationScope(delegation_id=delg.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id)
    db_session.add(delg_scope)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    decision = await evaluator.evaluate(
        actor_user_id=grantee.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
    )
    assert decision.allowed is False
    assert decision.reason_code == "PERMISSION_NOT_ASSIGNED"


@pytest.mark.asyncio
async def test_rule_7_institution_owner_cannot_delegate(db_session: AsyncSession):
    """Rule 7: INSTITUTION_OWNER authority CANNOT be delegated under any circumstances."""
    data = await _setup_institution_and_members(db_session)
    inst, grantor, grantee = data["inst"], data["grantor"], data["grantee"]
    m_grantor, m_grantee = data["m_grantor"], data["m_grantee"]

    owner_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "INSTITUTION_OWNER"))).scalar_one()
    assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_grantor.id,
        role_template_id=owner_role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assign)
    await db_session.flush()

    scope = RoleAssignmentScope(role_assignment_id=assign.id, institution_id=inst.id, scope_type=RoleScopeType.INSTITUTION)
    db_session.add(scope)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=assign.id,
        grantee_membership_id=m_grantee.id,
        status=DelegationLifecycleStatus.ACTIVE,
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=1),
        reason="Delegation rule 6",
    )
    db_session.add(delg)
    await db_session.flush()

    perm_inst_manage = (await db_session.execute(select(Permission).where(Permission.code == "institution.manage"))).scalar_one()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg.id, permission_id=perm_inst_manage.id))
    delg_scope = DelegationScope(delegation_id=delg.id, institution_id=inst.id, scope_type=RoleScopeType.INSTITUTION)
    db_session.add(delg_scope)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    decision = await evaluator.evaluate(
        actor_user_id=grantee.id,
        permission_code="institution.manage",
        institution_id=inst.id,
    )
    # Grantee evaluated for owner permission through delegation MUST BE REJECTED
    assert decision.allowed is False
    assert decision.reason_code == "PERMISSION_NOT_ASSIGNED"


@pytest.mark.asyncio
async def test_rule_8_grantor_inactive_membership_rejected(db_session: AsyncSession):
    """Rule 8: Grantor with SUSPENDED/REVOKED membership invalidates delegation."""
    data = await _setup_institution_and_members(db_session)
    inst, grantor, grantee = data["inst"], data["grantor"], data["grantee"]
    m_grantor, m_grantee, sec_a = data["m_grantor"], data["m_grantee"], data["sec_a"]

    # Suspend grantor membership
    m_grantor.status = MembershipStatus.SUSPENDED
    await db_session.flush()

    fac_role = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_grantor.id,
        role_template_id=fac_role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assign)
    await db_session.flush()

    scope = RoleAssignmentScope(role_assignment_id=assign.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id)
    db_session.add(scope)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=assign.id,
        grantee_membership_id=m_grantee.id,
        status=DelegationLifecycleStatus.ACTIVE,
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=1),
        reason="Delegation rule 6",
    )
    db_session.add(delg)
    await db_session.flush()

    perm_start = (await db_session.execute(select(Permission).where(Permission.code == "attendance.session.start"))).scalar_one()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg.id, permission_id=perm_start.id))
    delg_scope = DelegationScope(delegation_id=delg.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id)
    db_session.add(delg_scope)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    decision = await evaluator.evaluate(
        actor_user_id=grantee.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
    )
    assert decision.allowed is False
    assert decision.reason_code == "PERMISSION_NOT_ASSIGNED"
