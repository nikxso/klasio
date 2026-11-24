import uuid
from datetime import date, datetime, timedelta, timezone
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.user import User, UserRole, AccountStatus
from src.models.academic import Department, AcademicTerm, ClassSection, Subject, DEFAULT_INSTITUTION_ID
from src.models.assignment import TeachingAssignment
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
    DelegationType,
    DelegationLifecycleStatus,
    DelegationScope,
    Permission,
    delegation_permissions,
)
from src.services.iac_seed_service import seed_canonical_role_templates
from src.services.authorization_evaluator import AuthorizationEvaluator, AuthorizationDecision


async def _get_or_create_membership(session: AsyncSession, inst_id: uuid.UUID, user_id: uuid.UUID) -> InstitutionMembership:
    res = await session.execute(
        select(InstitutionMembership).where(
            InstitutionMembership.institution_id == inst_id,
            InstitutionMembership.user_id == user_id,
        )
    )
    mem = res.scalar_one_or_none()
    if not mem:
        mem = InstitutionMembership(institution_id=inst_id, user_id=user_id, status=MembershipStatus.ACTIVE)
        session.add(mem)
        await session.flush()
    return mem


async def _setup_test_context(db_session: AsyncSession):
    """Seed catalog and create institution, campus, departments, and academic terms."""
    await seed_canonical_role_templates(db_session)

    uid = uuid.uuid4().hex[:6]
    res_inst = await db_session.execute(select(Institution).where(Institution.id == DEFAULT_INSTITUTION_ID))
    inst = res_inst.scalar_one_or_none()
    if not inst:
        inst = Institution(id=DEFAULT_INSTITUTION_ID, code="KLASIO_MAIN", name=f"Test Institution {uid}")
        db_session.add(inst)
    inst_id = DEFAULT_INSTITUTION_ID
    campus_id = uuid.uuid4()
    campus = Campus(id=campus_id, institution_id=inst_id, code=f"CAMP_{uid}", name=f"Campus {uid}")
    dept_a_id = uuid.uuid4()
    dept_a = Department(id=dept_a_id, institution_id=inst_id, code=f"DEPT_A_{uid}", name=f"Department A {uid}")
    dept_b_id = uuid.uuid4()
    dept_b = Department(id=dept_b_id, institution_id=inst_id, code=f"DEPT_B_{uid}", name=f"Department B {uid}")
    term_id = uuid.uuid4()
    term = AcademicTerm(
        id=term_id,
        institution_id=inst_id,
        code=f"TERM_{uid}",
        name="Term 2026-1",
        academic_year="2026-2027",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
    )
    subject_a = Subject(
        id=uuid.uuid4(),
        institution_id=inst_id,
        department_id=dept_a_id,
        code=f"SUB_A_{uid}",
        name="Subject A",
    )
    subject_b = Subject(
        id=uuid.uuid4(),
        institution_id=inst_id,
        department_id=dept_b_id,
        code=f"SUB_B_{uid}",
        name="Subject B",
    )
    db_session.add_all([inst, campus, dept_a, dept_b, term, subject_a, subject_b])
    await db_session.flush()

    sec_a = ClassSection(
        id=uuid.uuid4(),
        institution_id=inst_id,
        campus_id=campus_id,
        department_id=dept_a_id,
        academic_term_id=term_id,
        section_code=f"SEC_A_{uid}",
        cohort_year=2024,
    )
    sec_b = ClassSection(
        id=uuid.uuid4(),
        institution_id=inst_id,
        campus_id=campus_id,
        department_id=dept_b_id,
        academic_term_id=term_id,
        section_code=f"SEC_B_{uid}",
        cohort_year=2024,
    )
    db_session.add_all([sec_a, sec_b])
    await db_session.flush()

    return {
        "inst": inst,
        "campus": campus,
        "dept_a": dept_a,
        "dept_b": dept_b,
        "term": term,
        "subject_a": subject_a,
        "subject_b": subject_b,
        "sec_a": sec_a,
        "sec_b": sec_b,
    }


@pytest.mark.asyncio
async def test_substitute_delegation_requires_approval(db_session: AsyncSession):
    """Verify that a FACULTY_SUBSTITUTE delegation requires ACTIVE status and HoD approval."""
    ctx = await _setup_test_context(db_session)
    inst, sec_a = ctx["inst"], ctx["sec_a"]

    # Create faculty grantor, faculty substitute grantee, and HoD user
    uid = uuid.uuid4().hex[:6]
    fac_grantor = User(
        institutional_id=f"FAC_G_{uid}",
        email=f"fac_g_{uid}@inst.edu",
        password_hash="pw",
        full_name="Grantor Faculty",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_sub = User(
        institutional_id=f"FAC_S_{uid}",
        email=f"fac_s_{uid}@inst.edu",
        password_hash="pw",
        full_name="Substitute Faculty",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    hod_user = User(
        institutional_id=f"HOD_{uid}",
        email=f"hod_{uid}@inst.edu",
        password_hash="pw",
        full_name="Head of Department",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([fac_grantor, fac_sub, hod_user])
    await db_session.flush()

    m_grantor = await _get_or_create_membership(db_session, inst.id, fac_grantor.id)
    m_sub = await _get_or_create_membership(db_session, inst.id, fac_sub.id)
    m_hod = await _get_or_create_membership(db_session, inst.id, hod_user.id)

    # Assign FACULTY role to grantor scoped to sec_a
    faculty_tpl = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    grantor_assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_grantor.id,
        role_template_id=faculty_tpl.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(grantor_assign)
    await db_session.flush()

    scope = RoleAssignmentScope(
        role_assignment_id=grantor_assign.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.CLASS_SECTION,
        class_section_id=sec_a.id,
    )
    db_session.add(scope)
    await db_session.flush()

    perm_start = (await db_session.execute(select(Permission).where(Permission.code == "attendance.session.start"))).scalar_one()

    now = datetime.now(timezone.utc)

    # 1. Substitute delegation in PENDING_APPROVAL status: MUST BE DENIED
    delg_pending = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=grantor_assign.id,
        grantee_membership_id=m_sub.id,
        delegation_type=DelegationType.FACULTY_SUBSTITUTE,
        status=DelegationLifecycleStatus.PENDING_APPROVAL,
        approved_by_membership_id=None,
        approved_at=None,
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=2),
        reason="Substitute coverage pending HoD",
    )
    db_session.add(delg_pending)
    await db_session.flush()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg_pending.id, permission_id=perm_start.id))
    db_session.add(DelegationScope(delegation_id=delg_pending.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id))
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    decision = await evaluator.evaluate(
        actor_user_id=fac_sub.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
    )
    assert decision.allowed is False, "Pending substitute delegation must not grant permissions"

    # 2. Substitute delegation with status ACTIVE but missing HoD approval metadata: MUST BE DENIED
    delg_unapproved = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=grantor_assign.id,
        grantee_membership_id=m_sub.id,
        delegation_type=DelegationType.FACULTY_SUBSTITUTE,
        status=DelegationLifecycleStatus.ACTIVE,
        approved_by_membership_id=None,
        approved_at=None,
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=2),
        reason="Active without approval metadata",
    )
    db_session.add(delg_unapproved)
    await db_session.flush()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg_unapproved.id, permission_id=perm_start.id))
    db_session.add(DelegationScope(delegation_id=delg_unapproved.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id))
    await db_session.commit()

    decision_unapproved = await evaluator.evaluate(
        actor_user_id=fac_sub.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
    )
    assert decision_unapproved.allowed is False, "Active substitute delegation without HoD approval metadata must not grant permissions"

    # 3. Substitute delegation with ACTIVE status AND HoD approval: MUST BE ALLOWED
    delg_approved = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=grantor_assign.id,
        grantee_membership_id=m_sub.id,
        delegation_type=DelegationType.FACULTY_SUBSTITUTE,
        status=DelegationLifecycleStatus.ACTIVE,
        approved_by_membership_id=m_hod.id,
        approved_at=now - timedelta(minutes=30),
        valid_from=now - timedelta(hours=1),
        valid_until=now + timedelta(days=2),
        reason="Approved substitute coverage",
    )
    db_session.add(delg_approved)
    await db_session.flush()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg_approved.id, permission_id=perm_start.id))
    db_session.add(DelegationScope(delegation_id=delg_approved.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id))
    await db_session.commit()

    decision_approved = await evaluator.evaluate(
        actor_user_id=fac_sub.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
    )
    assert decision_approved.allowed is True, "Approved active substitute delegation must grant permissions"
    assert decision_approved.delegation_id == delg_approved.id


@pytest.mark.asyncio
async def test_substitute_delegation_expired_and_revoked_denied(db_session: AsyncSession):
    """Verify that expired and revoked substitute delegations are denied."""
    ctx = await _setup_test_context(db_session)
    inst, sec_a = ctx["inst"], ctx["sec_a"]

    uid = uuid.uuid4().hex[:6]
    fac_grantor = User(
        institutional_id=f"FAC_G2_{uid}",
        email=f"fac_g2_{uid}@inst.edu",
        password_hash="pw",
        full_name="Grantor Faculty 2",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_sub = User(
        institutional_id=f"FAC_S2_{uid}",
        email=f"fac_s2_{uid}@inst.edu",
        password_hash="pw",
        full_name="Substitute Faculty 2",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    hod_user = User(
        institutional_id=f"HOD2_{uid}",
        email=f"hod2_{uid}@inst.edu",
        password_hash="pw",
        full_name="HoD User 2",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([fac_grantor, fac_sub, hod_user])
    await db_session.flush()

    m_grantor = await _get_or_create_membership(db_session, inst.id, fac_grantor.id)
    m_sub = await _get_or_create_membership(db_session, inst.id, fac_sub.id)
    m_hod = await _get_or_create_membership(db_session, inst.id, hod_user.id)

    faculty_tpl = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    grantor_assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_grantor.id,
        role_template_id=faculty_tpl.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(grantor_assign)
    await db_session.flush()

    scope = RoleAssignmentScope(
        role_assignment_id=grantor_assign.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.CLASS_SECTION,
        class_section_id=sec_a.id,
    )
    db_session.add(scope)
    await db_session.flush()

    perm_start = (await db_session.execute(select(Permission).where(Permission.code == "attendance.session.start"))).scalar_one()
    now = datetime.now(timezone.utc)

    # 1. Expired delegation: valid_until in the past
    delg_expired = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=grantor_assign.id,
        grantee_membership_id=m_sub.id,
        delegation_type=DelegationType.FACULTY_SUBSTITUTE,
        status=DelegationLifecycleStatus.ACTIVE,
        approved_by_membership_id=m_hod.id,
        approved_at=now - timedelta(days=5),
        valid_from=now - timedelta(days=5),
        valid_until=now - timedelta(days=1),
        reason="Expired delegation",
    )
    db_session.add(delg_expired)
    await db_session.flush()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg_expired.id, permission_id=perm_start.id))
    db_session.add(DelegationScope(delegation_id=delg_expired.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id))
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)
    dec_expired = await evaluator.evaluate(
        actor_user_id=fac_sub.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
        clock_now=now,
    )
    assert dec_expired.allowed is False, "Expired substitute delegation must be denied"

    # 2. Revoked delegation
    delg_revoked = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=grantor_assign.id,
        grantee_membership_id=m_sub.id,
        delegation_type=DelegationType.FACULTY_SUBSTITUTE,
        status=DelegationLifecycleStatus.REVOKED,
        approved_by_membership_id=m_hod.id,
        approved_at=now - timedelta(hours=2),
        valid_from=now - timedelta(hours=2),
        valid_until=now + timedelta(days=2),
        reason="Revoked substitute delegation",
    )
    db_session.add(delg_revoked)
    await db_session.flush()
    await db_session.execute(delegation_permissions.insert().values(delegation_id=delg_revoked.id, permission_id=perm_start.id))
    db_session.add(DelegationScope(delegation_id=delg_revoked.id, institution_id=inst.id, scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_a.id))
    await db_session.commit()

    dec_revoked = await evaluator.evaluate(
        actor_user_id=fac_sub.id,
        permission_code="attendance.session.start",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
        clock_now=now,
    )
    assert dec_revoked.allowed is False, "Revoked substitute delegation must be denied"


@pytest.mark.asyncio
async def test_biometrics_template_read_strictly_prohibited(db_session: AsyncSession):
    """Verify biometrics.template.read is denied for any account, including owner and admins."""
    ctx = await _setup_test_context(db_session)
    inst = ctx["inst"]

    uid = uuid.uuid4().hex[:6]
    owner_user = User(
        institutional_id=f"OWNER_{uid}",
        email=f"owner_{uid}@inst.edu",
        password_hash="pw",
        full_name="Institution Owner",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(owner_user)
    await db_session.flush()

    m_owner = await _get_or_create_membership(db_session, inst.id, owner_user.id)

    owner_tpl = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "INSTITUTION_OWNER"))).scalar_one()
    owner_assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_owner.id,
        role_template_id=owner_tpl.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(owner_assign)
    await db_session.flush()

    db_session.add(RoleAssignmentScope(
        role_assignment_id=owner_assign.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.INSTITUTION,
    ))
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)

    # Standard dot notation
    dec_dot = await evaluator.evaluate(
        actor_user_id=owner_user.id,
        permission_code="biometrics.template.read",
        institution_id=inst.id,
    )
    assert dec_dot.allowed is False
    assert dec_dot.reason_code == "BIOMETRIC_VECTOR_ACCESS_PROHIBITED"
    assert "Direct vector or biometric template access is strictly prohibited for all human accounts" in dec_dot.reason

    # Colon legacy notation
    dec_colon = await evaluator.evaluate(
        actor_user_id=owner_user.id,
        permission_code="biometrics:template:read",
        institution_id=inst.id,
    )
    assert dec_colon.allowed is False
    assert dec_colon.reason_code == "BIOMETRIC_VECTOR_ACCESS_PROHIBITED"
    assert "Direct vector or biometric template access is strictly prohibited for all human accounts" in dec_colon.reason


@pytest.mark.asyncio
async def test_department_isolation_and_scope_containment(db_session: AsyncSession):
    """Verify department isolation: Role in Department A cannot access Department B resources."""
    ctx = await _setup_test_context(db_session)
    inst, dept_a, dept_b = ctx["inst"], ctx["dept_a"], ctx["dept_b"]
    sec_a, sec_b = ctx["sec_a"], ctx["sec_b"]
    subject_a, subject_b = ctx["subject_a"], ctx["subject_b"]
    term = ctx["term"]

    uid = uuid.uuid4().hex[:6]
    dept_user = User(
        institutional_id=f"HOD_A_{uid}",
        email=f"hod_a_{uid}@inst.edu",
        password_hash="pw",
        full_name="Dept A Head",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(dept_user)
    await db_session.flush()

    mem_res = await db_session.execute(
        select(InstitutionMembership).where(InstitutionMembership.user_id == dept_user.id)
    )
    m_user = mem_res.scalar_one_or_none()
    if not m_user:
        m_user = InstitutionMembership(institution_id=inst.id, user_id=dept_user.id, status=MembershipStatus.ACTIVE)
        db_session.add(m_user)
        await db_session.flush()

    # Create teaching assignments in Sec A and Sec B
    ta_a = TeachingAssignment(
        faculty_user_id=dept_user.id,
        class_section_id=sec_a.id,
        subject_id=subject_a.id,
        academic_term_id=term.id,
        created_by_user_id=dept_user.id,
    )
    ta_b = TeachingAssignment(
        faculty_user_id=dept_user.id,
        class_section_id=sec_b.id,
        subject_id=subject_b.id,
        academic_term_id=term.id,
        created_by_user_id=dept_user.id,
    )
    db_session.add_all([ta_a, ta_b])
    await db_session.flush()

    hod_tpl = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "DEPARTMENT_HEAD"))).scalar_one()
    assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_user.id,
        role_template_id=hod_tpl.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assign)
    await db_session.flush()

    # Scope role assignment strictly to Department A
    scope_a = RoleAssignmentScope(
        role_assignment_id=assign.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.DEPARTMENT,
        department_id=dept_a.id,
    )
    db_session.add(scope_a)
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)

    # 1. Section in Department A: ALLOWED
    dec_sec_a = await evaluator.evaluate(
        actor_user_id=dept_user.id,
        permission_code="attendance.session.view",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
    )
    assert dec_sec_a.allowed is True
    assert dec_sec_a.reason_code == "ALLOWED"

    # 2. TeachingAssignment in Department A: ALLOWED
    dec_ta_a = await evaluator.evaluate(
        actor_user_id=dept_user.id,
        permission_code="attendance.session.view",
        institution_id=inst.id,
        resource_type="TEACHING_ASSIGNMENT",
        resource_id=ta_a.id,
    )
    assert dec_ta_a.allowed is True
    assert dec_ta_a.reason_code == "ALLOWED"

    # 3. Section in Department B: DENIED with SCOPE_MISMATCH
    dec_sec_b = await evaluator.evaluate(
        actor_user_id=dept_user.id,
        permission_code="attendance.session.view",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_b.id,
    )
    assert dec_sec_b.allowed is False
    assert dec_sec_b.reason_code == "SCOPE_MISMATCH"

    # 4. TeachingAssignment in Department B: DENIED with SCOPE_MISMATCH
    dec_ta_b = await evaluator.evaluate(
        actor_user_id=dept_user.id,
        permission_code="attendance.session.view",
        institution_id=inst.id,
        resource_type="TEACHING_ASSIGNMENT",
        resource_id=ta_b.id,
    )
    assert dec_ta_b.allowed is False
    assert dec_ta_b.reason_code == "SCOPE_MISMATCH"


@pytest.mark.asyncio
async def test_legacy_permission_mapping(db_session: AsyncSession):
    """Verify that legacy colon-separated permission strings map seamlessly to canonical permissions."""
    ctx = await _setup_test_context(db_session)
    inst, sec_a = ctx["inst"], ctx["sec_a"]

    uid = uuid.uuid4().hex[:6]
    fac_user = User(
        institutional_id=f"FAC_LEG_{uid}",
        email=f"fac_leg_{uid}@inst.edu",
        password_hash="pw",
        full_name="Legacy Perm Faculty",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(fac_user)
    await db_session.flush()

    m_fac = await _get_or_create_membership(db_session, inst.id, fac_user.id)

    faculty_tpl = (await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))).scalar_one()
    assign = RoleAssignment(
        institution_id=inst.id,
        membership_id=m_fac.id,
        role_template_id=faculty_tpl.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assign)
    await db_session.flush()

    db_session.add(RoleAssignmentScope(
        role_assignment_id=assign.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.CLASS_SECTION,
        class_section_id=sec_a.id,
    ))
    await db_session.commit()

    evaluator = AuthorizationEvaluator(db_session)

    # attendance:scan maps to attendance.session.start -> ALLOWED
    dec_scan = await evaluator.evaluate(
        actor_user_id=fac_user.id,
        permission_code="attendance:scan",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
    )
    assert dec_scan.allowed is True
    assert dec_scan.reason_code == "ALLOWED"

    # attendance:finalize maps to attendance.session.finalize -> ALLOWED
    dec_finalize = await evaluator.evaluate(
        actor_user_id=fac_user.id,
        permission_code="attendance:finalize",
        institution_id=inst.id,
        resource_type="CLASS_SECTION",
        resource_id=sec_a.id,
    )
    assert dec_finalize.allowed is True
    assert dec_finalize.reason_code == "ALLOWED"

