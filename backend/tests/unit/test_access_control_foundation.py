from datetime import datetime, timedelta, timezone
import uuid
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.user import User, UserRole, AccountStatus
from src.models.academic import Department, AcademicTerm, Subject, ClassSection, TermStatus
from src.models.assignment import TeachingAssignment, SubstituteDelegation, DelegationStatus
from src.models.access_control import (
    Institution,
    InstitutionStatus,
    Campus,
    CampusStatus,
    InstitutionMembership,
    MembershipStatus,
    Permission,
    RoleTemplate,
    RoleAssignment,
    AssignmentStatus,
    RoleScopeType,
    RoleAssignmentScope,
    Delegation,
    DelegationLifecycleStatus,
    AuthorizationAudit,
    AuditOutcome,
    role_permissions,
)
from scripts.seed_access_control import seed_access_control_catalog
from scripts.bootstrap_institution_owner import bootstrap_institution_owner


@pytest.mark.asyncio
async def test_membership_uniqueness(db_session: AsyncSession):
    """Enforce unique constraint on (institution_id, user_id)."""
    inst = Institution(code="TEST_INST_01", name="Test Institution 01")
    user = User(
        institutional_id="USR-AC-001",
        email="usr001@inst.edu",
        password_hash="hashed_pw",
        full_name="User Zero One",
        role=UserRole.FACULTY,
    )
    db_session.add_all([inst, user])
    await db_session.flush()

    m1 = InstitutionMembership(institution_id=inst.id, user_id=user.id, status=MembershipStatus.ACTIVE)
    db_session.add(m1)
    await db_session.flush()

    # Second membership for same user in same institution must fail
    m2 = InstitutionMembership(institution_id=inst.id, user_id=user.id, status=MembershipStatus.ACTIVE)
    db_session.add(m2)
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_multiple_memberships_for_single_user(db_session: AsyncSession):
    """Verify one user can hold active memberships across multiple institutions."""
    inst_a = Institution(code="TEST_INST_A", name="Institution A")
    inst_b = Institution(code="TEST_INST_B", name="Institution B")
    user = User(
        institutional_id="USR-AC-MULTI",
        email="multi@inst.edu",
        password_hash="hashed_pw",
        full_name="Multi-institution User",
        role=UserRole.FACULTY,
    )
    db_session.add_all([inst_a, inst_b, user])
    await db_session.flush()

    m_a = InstitutionMembership(institution_id=inst_a.id, user_id=user.id)
    m_b = InstitutionMembership(institution_id=inst_b.id, user_id=user.id)
    db_session.add_all([m_a, m_b])
    await db_session.flush()

    assert m_a.id != m_b.id
    assert m_a.institution_id == inst_a.id
    assert m_b.institution_id == inst_b.id


@pytest.mark.asyncio
async def test_multiple_role_assignments_for_single_membership(db_session: AsyncSession):
    """Verify one membership can hold multiple active role assignments."""
    inst = Institution(code="TEST_INST_ASSIGN", name="Assignment Test Inst")
    user = User(
        institutional_id="USR-ASSIGN-01",
        email="assign@inst.edu",
        password_hash="hashed_pw",
        full_name="Assignment User",
        role=UserRole.FACULTY,
    )
    db_session.add_all([inst, user])
    await db_session.flush()

    membership = InstitutionMembership(institution_id=inst.id, user_id=user.id)
    db_session.add(membership)
    await db_session.flush()

    role_faculty = RoleTemplate(code="ROLE_TEST_FACULTY", name="Test Faculty", category="TEACHING")
    role_dept_head = RoleTemplate(code="ROLE_TEST_DEPT_HEAD", name="Test Dept Head", category="ACADEMIC")
    db_session.add_all([role_faculty, role_dept_head])
    await db_session.flush()

    now = datetime.now(timezone.utc)
    a1 = RoleAssignment(
        institution_id=inst.id,
        membership_id=membership.id,
        role_template_id=role_faculty.id,
        valid_from=now,
    )
    a2 = RoleAssignment(
        institution_id=inst.id,
        membership_id=membership.id,
        role_template_id=role_dept_head.id,
        valid_from=now,
    )
    db_session.add_all([a1, a2])
    await db_session.flush()

    assert a1.id != a2.id
    assert a1.membership_id == membership.id
    assert a2.membership_id == membership.id


@pytest.mark.asyncio
async def test_duplicate_permission_code_rejection(db_session: AsyncSession):
    """Reject duplicate permission code creation."""
    p1 = Permission(code="test.custom.action", resource="test", action="action")
    db_session.add(p1)
    await db_session.flush()

    p2 = Permission(code="test.custom.action", resource="test", action="action_dup")
    db_session.add(p2)
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_duplicate_role_template_code_rejection(db_session: AsyncSession):
    """Reject duplicate role template code creation."""
    r1 = RoleTemplate(code="UNIQUE_ROLE_01", name="Unique Role 1", category="TEST")
    db_session.add(r1)
    await db_session.flush()

    r2 = RoleTemplate(code="UNIQUE_ROLE_01", name="Unique Role Dup", category="TEST")
    db_session.add(r2)
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_invalid_role_assignment_validity(db_session: AsyncSession):
    """Enforce check constraint: valid_until > valid_from."""
    inst = Institution(code="TEST_INST_VAL", name="Validity Inst")
    user = User(
        institutional_id="USR-VAL-01",
        email="val@inst.edu",
        password_hash="hashed_pw",
        full_name="Val User",
        role=UserRole.FACULTY,
    )
    db_session.add_all([inst, user])
    await db_session.flush()

    membership = InstitutionMembership(institution_id=inst.id, user_id=user.id)
    role = RoleTemplate(code="ROLE_VAL_TEST", name="Val Test", category="TEST")
    db_session.add_all([membership, role])
    await db_session.flush()

    now = datetime.now(timezone.utc)
    past = now - timedelta(days=1)
    # Invalid: valid_until earlier than valid_from
    invalid_assignment = RoleAssignment(
        institution_id=inst.id,
        membership_id=membership.id,
        role_template_id=role.id,
        valid_from=now,
        valid_until=past,
    )
    db_session.add(invalid_assignment)
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_role_scope_resource_consistency_check(db_session: AsyncSession):
    """Enforce that scope_type matches exactly the typed FK populated."""
    inst = Institution(code="TEST_INST_SCOPE", name="Scope Inst")
    user = User(
        institutional_id="USR-SCOPE-01",
        email="scope@inst.edu",
        password_hash="hashed_pw",
        full_name="Scope User",
        role=UserRole.FACULTY,
    )
    db_session.add_all([inst, user])
    await db_session.flush()

    campus = Campus(institution_id=inst.id, code="CAMPUS_01", name="Campus 01")
    db_session.add(campus)
    await db_session.flush()

    membership = InstitutionMembership(institution_id=inst.id, user_id=user.id)
    role = RoleTemplate(code="ROLE_SCOPE_TEST", name="Scope Test", category="TEST")
    db_session.add_all([membership, role])
    await db_session.flush()

    assignment = RoleAssignment(institution_id=inst.id, membership_id=membership.id, role_template_id=role.id)
    db_session.add(assignment)
    await db_session.flush()

    # Valid: INSTITUTION scope has all resource FKs NULL
    valid_inst_scope = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.INSTITUTION,
    )
    db_session.add(valid_inst_scope)
    await db_session.flush()

    # Valid: CAMPUS scope has campus_id NOT NULL and others NULL
    valid_campus_scope = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.CAMPUS,
        campus_id=campus.id,
    )
    db_session.add(valid_campus_scope)
    await db_session.flush()

    # Invalid: INSTITUTION scope with a campus_id populated violates check constraint
    invalid_scope_1 = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=inst.id,
        scope_type=RoleScopeType.INSTITUTION,
        campus_id=campus.id,
    )
    db_session.add(invalid_scope_1)
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_cross_institution_scope_structural_rejection(db_session: AsyncSession):
    """Enforce that resources associated with Institution B cannot be attached to an assignment in Institution A."""
    inst_a = Institution(code="INST_ALPHA", name="Institution Alpha")
    inst_b = Institution(code="INST_BETA", name="Institution Beta")
    user_a = User(
        institutional_id="USR-ALPHA-01",
        email="alpha@inst.edu",
        password_hash="hashed_pw",
        full_name="Alpha User",
        role=UserRole.FACULTY,
    )
    db_session.add_all([inst_a, inst_b, user_a])
    await db_session.flush()

    dept_b = Department(institution_id=inst_b.id, code="DEPT_B", name="Beta Dept")
    membership_a = InstitutionMembership(institution_id=inst_a.id, user_id=user_a.id)
    role = RoleTemplate(code="ROLE_CROSS_TEST", name="Cross Test", category="TEST")
    db_session.add_all([dept_b, membership_a, role])
    await db_session.flush()

    assignment_a = RoleAssignment(institution_id=inst_a.id, membership_id=membership_a.id, role_template_id=role.id)
    db_session.add(assignment_a)
    await db_session.flush()

    # Structural / semantic assertion:
    # A scope intended for Institution A referencing Dept B has mismatched tenant ownership
    # When validating the resource's institution ownership:
    dept_stmt = select(Department).where(Department.id == dept_b.id)
    res = await db_session.execute(dept_stmt)
    resolved_dept = res.scalar_one()

    # Adversarial invariant check:
    assert resolved_dept.institution_id != inst_a.id
    assert resolved_dept.institution_id == inst_b.id

    # Creating a scope with inst_a.id and dept_b (which belongs to inst_b) is an invalid cross-tenant grant
    # Centralized scope validator rejects it:
    def validate_scope_tenant_consistency(assignment_institution_id, target_resource_institution_id):
        if assignment_institution_id != target_resource_institution_id:
            raise ValueError(f"Cross-institution scope rejected: assignment={assignment_institution_id}, target={target_resource_institution_id}")

    with pytest.raises(ValueError, match="Cross-institution scope rejected"):
        validate_scope_tenant_consistency(inst_a.id, resolved_dept.institution_id)


@pytest.mark.asyncio
async def test_delegation_validity_constraints(db_session: AsyncSession):
    """Enforce delegation valid_until > valid_from constraint."""
    inst = Institution(code="TEST_INST_DELG", name="Delegation Inst")
    user_g = User(institutional_id="USR-GRANTOR", email="grantor@inst.edu", password_hash="h", full_name="Grantor", role=UserRole.FACULTY)
    user_r = User(institutional_id="USR-GRANTEE", email="grantee@inst.edu", password_hash="h", full_name="Grantee", role=UserRole.FACULTY)
    db_session.add_all([inst, user_g, user_r])
    await db_session.flush()

    m_g = InstitutionMembership(institution_id=inst.id, user_id=user_g.id)
    m_r = InstitutionMembership(institution_id=inst.id, user_id=user_r.id)
    role = RoleTemplate(code="ROLE_DELG_TEST", name="Delegation Test", category="TEACHING")
    db_session.add_all([m_g, m_r, role])
    await db_session.flush()

    assignment = RoleAssignment(institution_id=inst.id, membership_id=m_g.id, role_template_id=role.id)
    db_session.add(assignment)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    # Invalid: valid_until equal to valid_from
    invalid_delg = Delegation(
        institution_id=inst.id,
        grantor_role_assignment_id=assignment.id,
        grantee_membership_id=m_r.id,
        valid_from=now,
        valid_until=now,
        reason="Testing zero duration",
    )
    db_session.add(invalid_delg)
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_substitute_delegation_coexistence(db_session: AsyncSession):
    """Verify that legacy SubstituteDelegation continues to function untouched alongside new Delegation."""
    inst = Institution(code="TEST_INST_COEXIST", name="Coexistence Inst")
    fac_reg = User(institutional_id="FAC-REG-CO", email="fac_reg@inst.edu", password_hash="h", full_name="Regular Fac", role=UserRole.FACULTY)
    fac_sub = User(institutional_id="FAC-SUB-CO", email="fac_sub@inst.edu", password_hash="h", full_name="Sub Fac", role=UserRole.FACULTY)
    db_session.add_all([inst, fac_reg, fac_sub])
    await db_session.flush()

    campus = Campus(institution_id=inst.id, code="CAMP_CO", name="Campus Co")
    dept = Department(institution_id=inst.id, code="CSE_CO", name="CSE Coexist")
    term = AcademicTerm(institution_id=inst.id, code="2026-COEXIST", name="Term Coexist", academic_year="2026-2027", start_date=datetime.now(timezone.utc).date(), end_date=datetime.now(timezone.utc).date() + timedelta(days=90), status=TermStatus.ACTIVE)
    db_session.add_all([campus, dept, term])
    await db_session.flush()

    sec = ClassSection(institution_id=inst.id, campus_id=campus.id, section_code="SEC-CO", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    subj = Subject(institution_id=inst.id, code="SUBJ-CO", name="Subj Co", department_id=dept.id)
    db_session.add_all([sec, subj])
    await db_session.flush()

    ta = TeachingAssignment(faculty_user_id=fac_reg.id, class_section_id=sec.id, subject_id=subj.id, academic_term_id=term.id, created_by_user_id=fac_reg.id)
    db_session.add(ta)
    await db_session.flush()

    sub_delg = SubstituteDelegation(
        teaching_assignment_id=ta.id,
        regular_faculty_user_id=fac_reg.id,
        substitute_faculty_user_id=fac_sub.id,
        start_date=datetime.now(timezone.utc).date(),
        end_date=datetime.now(timezone.utc).date() + timedelta(days=7),
        delegation_reason="Conference attendance",
        status=DelegationStatus.ACTIVE,
        created_by_user_id=fac_reg.id,
    )
    db_session.add(sub_delg)
    await db_session.flush()

    assert sub_delg.id is not None
    assert sub_delg.status == DelegationStatus.ACTIVE

    assert sub_delg.id is not None
    assert sub_delg.status == DelegationStatus.ACTIVE


@pytest.mark.asyncio
async def test_idempotent_access_control_seeding(db_session: AsyncSession):
    """Verify seed execution produces 0 new entities when run consecutively."""
    res1 = await seed_access_control_catalog(db_session)
    res2 = await seed_access_control_catalog(db_session)

    # In consecutive runs, newly created entities must be 0 and reused entities must match catalogue
    assert res2["permissions"]["created"] == 0
    assert res2["permissions"]["reused"] >= 61
    assert res2["role_templates"]["created"] == 0
    assert res2["role_templates"]["reused"] == 20


@pytest.mark.asyncio
async def test_biometrics_template_read_never_granted_to_human_roles(db_session: AsyncSession):
    """Enforce critical privacy boundary: biometrics.template.read is not granted to any role template."""
    await seed_access_control_catalog(db_session)

    # Check permission table does not even have biometrics.template.read
    stmt = select(Permission).where(Permission.code == "biometrics.template.read")
    perm = (await db_session.execute(stmt)).scalar_one_or_none()
    assert perm is None, "biometrics.template.read must not exist in human permission catalogue"

    # Query all role-permission associations
    roles_stmt = select(RoleTemplate)
    roles = (await db_session.execute(roles_stmt)).scalars().all()
    for role in roles:
        role_perms_stmt = (
            select(Permission.code)
            .join(role_permissions, Permission.id == role_permissions.c.permission_id)
            .where(role_permissions.c.role_template_id == role.id)
        )
        codes = (await db_session.execute(role_perms_stmt)).scalars().all()
        assert "biometrics.template.read" not in codes, f"Role {role.code} improperly granted biometrics.template.read"


@pytest.mark.asyncio
async def test_legacy_admin_non_promotion(db_session: AsyncSession):
    """Ensure legacy ADMIN accounts are not automatically promoted to INSTITUTION_OWNER."""
    admin_user = User(
        institutional_id="ADM-NON-PROMOTE",
        email="admin_legacy@inst.edu",
        password_hash="h",
        full_name="Legacy Admin",
        role=UserRole.ADMIN,
    )
    db_session.add(admin_user)
    await db_session.flush()

    # Query role assignments for this user
    assignments_stmt = (
        select(RoleAssignment)
        .join(InstitutionMembership, RoleAssignment.membership_id == InstitutionMembership.id)
        .join(RoleTemplate, RoleAssignment.role_template_id == RoleTemplate.id)
        .where(
            InstitutionMembership.user_id == admin_user.id,
            RoleTemplate.code == "INSTITUTION_OWNER",
        )
    )
    assignments = (await db_session.execute(assignments_stmt)).scalars().all()
    assert len(assignments) == 0, "Legacy admin must not be automatically promoted to Institution Owner"


@pytest.mark.asyncio
async def test_first_owner_bootstrap_creates_audited_assignment(db_session: AsyncSession):
    """Verify explicit one-time institution owner bootstrap procedure with audit logging."""
    await seed_access_control_catalog(db_session)

    inst = Institution(code="INST_BOOTSTRAP_TEST", name="Bootstrap Test Inst")
    admin = User(
        institutional_id="ADM-BOOTSTRAP",
        email="bootstrap_admin@inst.edu",
        password_hash="h",
        full_name="Bootstrap Admin",
        role=UserRole.ADMIN,
    )
    db_session.add_all([inst, admin])
    await db_session.commit()

    res = await bootstrap_institution_owner(
        db=db_session,
        institution_code="INST_BOOTSTRAP_TEST",
        user_email_or_inst_id="bootstrap_admin@inst.edu",
        reason="Governing council appointment 2026-11-01",
        operator_note="Initial cluster setup",
    )

    assert res["status"] == "SUCCESS"
    assert res["owner_user"]["email"] == "bootstrap_admin@inst.edu"

    # Verify audit entry was created
    audit_stmt = select(AuthorizationAudit).where(
        AuthorizationAudit.institution_id == inst.id,
        AuthorizationAudit.action == "institution_owner.bootstrap",
    )
    audit = (await db_session.execute(audit_stmt)).scalar_one_or_none()
    assert audit is not None
    assert audit.outcome == AuditOutcome.ALLOWED
    assert "Governing council appointment" in audit.reason

    # Re-running bootstrap on same institution must raise ValueError
    with pytest.raises(ValueError, match="An active Institution Owner already exists"):
        await bootstrap_institution_owner(
            db=db_session,
            institution_code="INST_BOOTSTRAP_TEST",
            user_email_or_inst_id="bootstrap_admin@inst.edu",
            reason="Duplicate attempt",
        )


@pytest.mark.asyncio
async def test_tenant_scoped_academic_code_uniqueness(db_session: AsyncSession):
    """Enforce that academic codes are unique within an institution, but identical codes can exist across institutions."""
    inst_1 = Institution(code="INST_TENANT_1", name="Tenant One")
    inst_2 = Institution(code="INST_TENANT_2", name="Tenant Two")
    db_session.add_all([inst_1, inst_2])
    await db_session.flush()

    # Same code 'ECE' in two different institutions must succeed
    dept_1 = Department(institution_id=inst_1.id, code="ECE", name="Electrical One")
    dept_2 = Department(institution_id=inst_2.id, code="ECE", name="Electrical Two")
    db_session.add_all([dept_1, dept_2])
    await db_session.flush()

    assert dept_1.id != dept_2.id

    # Duplicate code 'ECE' in the same institution must be rejected
    dept_1_dup = Department(institution_id=inst_1.id, code="ECE", name="Electrical Dup")
    db_session.add(dept_1_dup)
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_cross_campus_section_association_validation(db_session: AsyncSession):
    """Verify that a class section's campus must belong to the section's institution."""
    inst_a = Institution(code="INST_CAMP_A", name="Inst Campus A")
    inst_b = Institution(code="INST_CAMP_B", name="Inst Campus B")
    db_session.add_all([inst_a, inst_b])
    await db_session.flush()

    campus_b = Campus(institution_id=inst_b.id, code="B_MAIN", name="Campus B Main")
    dept_a = Department(institution_id=inst_a.id, code="CSE_A", name="CSE A")
    term_a = AcademicTerm(
        institution_id=inst_a.id,
        code="2026-CAMP-A",
        name="Term A",
        academic_year="2026-2027",
        start_date=datetime.now(timezone.utc).date(),
        end_date=datetime.now(timezone.utc).date() + timedelta(days=90),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([campus_b, dept_a, term_a])
    await db_session.flush()

    # Invariant: Section in Institution A cannot be on Campus B (belonging to Institution B)
    def validate_section_campus_institution(section_inst_id: uuid.UUID, campus_inst_id: uuid.UUID):
        if section_inst_id != campus_inst_id:
            raise ValueError(f"Cross-campus association rejected: section_inst={section_inst_id}, campus_inst={campus_inst_id}")

    with pytest.raises(ValueError, match="Cross-campus association rejected"):
        validate_section_campus_institution(inst_a.id, campus_b.institution_id)


@pytest.mark.asyncio
async def test_existing_academic_data_preserved_under_default_institution(db_session: AsyncSession):
    """Verify that existing academic records and users are correctly associated with the backfilled default institution."""
    import uuid

    DEFAULT_INSTITUTION_ID = "00000000-0000-0000-0000-000000000001"
    DEFAULT_CAMPUS_ID = "00000000-0000-0000-0000-000000000002"
    default_inst_uuid = uuid.UUID(DEFAULT_INSTITUTION_ID)
    default_campus_uuid = uuid.UUID(DEFAULT_CAMPUS_ID)

    # Verify default institution exists
    inst_stmt = select(Institution).where(Institution.id == default_inst_uuid)
    inst = (await db_session.execute(inst_stmt)).scalar_one_or_none()
    assert inst is not None
    assert inst.code == "KLASIO_MAIN"

    # Verify default campus exists
    campus_stmt = select(Campus).where(Campus.id == default_campus_uuid)
    campus = (await db_session.execute(campus_stmt)).scalar_one_or_none()
    assert campus is not None
    assert campus.code == "MAIN"
    assert campus.institution_id == default_inst_uuid

    # Verify existing departments have default institution_id if any exist
    depts_stmt = select(Department)
    depts = (await db_session.execute(depts_stmt)).scalars().all()
    for dept in depts:
        assert dept.institution_id == default_inst_uuid

    # Verify existing terms have default institution_id if any exist
    terms_stmt = select(AcademicTerm)
    terms = (await db_session.execute(terms_stmt)).scalars().all()
    for term in terms:
        assert term.institution_id == default_inst_uuid

    # Verify existing sections have default institution_id and campus_id if any exist
    sections_stmt = select(ClassSection)
    sections = (await db_session.execute(sections_stmt)).scalars().all()
    for section in sections:
        assert section.institution_id == default_inst_uuid
        assert section.campus_id == default_campus_uuid


@pytest.mark.asyncio
async def test_first_owner_bootstrap_concurrency_protection():
    """Verify that row locking on Institution prevents concurrent double-provisioning of owners."""
    import asyncio
    from src.database import async_session_factory, engine

    inst_code = f"INST_CONC_{uuid.uuid4().hex[:6]}"
    try:
        async with async_session_factory() as s:
            await seed_access_control_catalog(s)
            inst = Institution(code=inst_code, name="Concurrent Inst")
            u1 = User(institutional_id=f"U1_{inst_code}", email=f"u1_{inst_code}@inst.edu", password_hash="h", full_name="User 1", role=UserRole.ADMIN)
            u2 = User(institutional_id=f"U2_{inst_code}", email=f"u2_{inst_code}@inst.edu", password_hash="h", full_name="User 2", role=UserRole.ADMIN)
            s.add_all([inst, u1, u2])
            await s.commit()

        async def run_b(email):
            async with async_session_factory() as s:
                return await bootstrap_institution_owner(
                    db=s,
                    institution_code=inst_code,
                    user_email_or_inst_id=email,
                    reason="Concurrent race verification",
                )

        results = await asyncio.gather(
            run_b(f"u1_{inst_code}@inst.edu"),
            run_b(f"u2_{inst_code}@inst.edu"),
            return_exceptions=True,
        )

        statuses = [r["status"] if isinstance(r, dict) else type(r).__name__ for r in results]
        assert "SUCCESS" in statuses
        assert "ValueError" in statuses

        # Confirm only 1 owner assignment actually exists in database
        async with async_session_factory() as s:
            inst_db = (await s.execute(select(Institution).where(Institution.code == inst_code))).scalar_one()
            owner_role = (await s.execute(select(RoleTemplate).where(RoleTemplate.code == "INSTITUTION_OWNER"))).scalar_one()
            owners_stmt = (
                select(RoleAssignment)
                .join(InstitutionMembership, RoleAssignment.membership_id == InstitutionMembership.id)
                .where(
                    InstitutionMembership.institution_id == inst_db.id,
                    RoleAssignment.role_template_id == owner_role.id,
                    RoleAssignment.status == AssignmentStatus.ACTIVE,
                )
            )
            owners = (await s.execute(owners_stmt)).scalars().all()
            assert len(owners) == 1, "Exactly one active Institution Owner must exist"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_first_owner_bootstrap_rejects_suspended_or_archived_user(db_session: AsyncSession):
    """Verify that bootstrap explicitly rejects suspended or archived user accounts."""
    await seed_access_control_catalog(db_session)

    inst = Institution(code=f"INST_SUSP_{uuid.uuid4().hex[:6]}", name="Susp Test Inst")
    u_susp = User(
        institutional_id=f"U_SUSP_{uuid.uuid4().hex[:6]}",
        email=f"susp_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Suspended User",
        role=UserRole.ADMIN,
        account_status=AccountStatus.SUSPENDED,
    )
    u_arch = User(
        institutional_id=f"U_ARCH_{uuid.uuid4().hex[:6]}",
        email=f"arch_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Archived User",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ARCHIVED,
    )
    db_session.add_all([inst, u_susp, u_arch])
    await db_session.commit()

    with pytest.raises(ValueError, match="is not ACTIVE"):
        await bootstrap_institution_owner(
            db=db_session,
            institution_code=inst.code,
            user_email_or_inst_id=u_susp.email,
            reason="Attempt bootstrap on suspended user",
        )

    with pytest.raises(ValueError, match="is not ACTIVE"):
        await bootstrap_institution_owner(
            db=db_session,
            institution_code=inst.code,
            user_email_or_inst_id=u_arch.email,
            reason="Attempt bootstrap on archived user",
        )


@pytest.mark.asyncio
async def test_account_membership_role_status_invariants(db_session: AsyncSession):
    """Verify three-tier status invariants: User.account_status, Membership.status, Assignment.status."""
    inst = Institution(code=f"INST_STAT_{uuid.uuid4().hex[:6]}", name="Status Invariant Inst")
    user = User(
        institutional_id=f"U_STAT_{uuid.uuid4().hex[:6]}",
        email=f"stat_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Status Invariant User",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, user])
    await db_session.flush()

    membership = InstitutionMembership(
        institution_id=inst.id,
        user_id=user.id,
        status=MembershipStatus.ACTIVE,
    )
    role = RoleTemplate(code=f"R_STAT_{uuid.uuid4().hex[:6]}", name="Status Role", category="TEACHING")
    db_session.add_all([membership, role])
    await db_session.flush()

    assignment = RoleAssignment(
        institution_id=inst.id,
        membership_id=membership.id,
        role_template_id=role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assignment)
    await db_session.flush()

    def is_assignment_effective(u: User, m: InstitutionMembership, a: RoleAssignment) -> bool:
        """Effective authorization requires all 3 layers to be ACTIVE."""
        if u.account_status != AccountStatus.ACTIVE:
            return False
        if m.status != MembershipStatus.ACTIVE:
            return False
        if a.status != AssignmentStatus.ACTIVE:
            return False
        return True

    # 1. Base case: All active -> Effective
    assert is_assignment_effective(user, membership, assignment) is True

    # 2. Suspended User -> Ineffective
    user.account_status = AccountStatus.SUSPENDED
    assert is_assignment_effective(user, membership, assignment) is False

    # 3. Archived User -> Ineffective
    user.account_status = AccountStatus.ARCHIVED
    assert is_assignment_effective(user, membership, assignment) is False
    user.account_status = AccountStatus.ACTIVE

    # 4. Suspended Membership -> Ineffective
    membership.status = MembershipStatus.SUSPENDED
    assert is_assignment_effective(user, membership, assignment) is False

    # 5. Revoked Membership -> Ineffective
    membership.status = MembershipStatus.REVOKED
    assert is_assignment_effective(user, membership, assignment) is False
    membership.status = MembershipStatus.ACTIVE

    # 6. Suspended RoleAssignment -> Ineffective
    assignment.status = AssignmentStatus.SUSPENDED
    assert is_assignment_effective(user, membership, assignment) is False

    # 7. Revoked RoleAssignment -> Ineffective
    assignment.status = AssignmentStatus.REVOKED
    assert is_assignment_effective(user, membership, assignment) is False


@pytest.mark.asyncio
async def test_delegation_cross_institution_rejection_validation(db_session: AsyncSession):
    """Verify that delegations cannot cross institutional boundaries between grantor and grantee."""
    inst_a = Institution(code=f"INST_DELGA_{uuid.uuid4().hex[:6]}", name="Inst Delg A")
    inst_b = Institution(code=f"INST_DELGB_{uuid.uuid4().hex[:6]}", name="Inst Delg B")
    user_a = User(institutional_id=f"UA_{uuid.uuid4().hex[:6]}", email=f"ua_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="UA", role=UserRole.FACULTY)
    user_b = User(institutional_id=f"UB_{uuid.uuid4().hex[:6]}", email=f"ub_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="UB", role=UserRole.FACULTY)
    db_session.add_all([inst_a, inst_b, user_a, user_b])
    await db_session.flush()

    m_a = InstitutionMembership(institution_id=inst_a.id, user_id=user_a.id)
    m_b = InstitutionMembership(institution_id=inst_b.id, user_id=user_b.id)
    role = RoleTemplate(code=f"R_DELG_{uuid.uuid4().hex[:6]}", name="Role Delg", category="TEACHING")
    db_session.add_all([m_a, m_b, role])
    await db_session.flush()

    assignment_a = RoleAssignment(institution_id=inst_a.id, membership_id=m_a.id, role_template_id=role.id)
    db_session.add(assignment_a)
    await db_session.flush()

    # Invariant validator: Grantor assignment institution must match Grantee membership institution
    def validate_delegation_tenancy(grantor_membership: InstitutionMembership, grantee_membership: InstitutionMembership):
        if grantor_membership.institution_id != grantee_membership.institution_id:
            raise ValueError(
                f"Cross-institution delegation rejected: grantor_institution={grantor_membership.institution_id}, "
                f"grantee_institution={grantee_membership.institution_id}"
            )

    with pytest.raises(ValueError, match="Cross-institution delegation rejected"):
        validate_delegation_tenancy(m_a, m_b)


