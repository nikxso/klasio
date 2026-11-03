"""Direct PostgreSQL Tenant Integrity & Composite Constraint Tests.

Verifies that cross-institution associations are structurally REJECTED by PostgreSQL itself,
completely bypassing application-level checks.
"""
from datetime import datetime, date, timezone, timedelta
import uuid
import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.user import User, UserRole
from src.models.academic import Department, AcademicTerm, Subject, ClassSection, TermStatus
from src.models.access_control import (
    Institution,
    Campus,
    department_campuses,
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
)


@pytest.mark.asyncio
async def test_pg_rejects_class_section_with_cross_institution_campus(db_session: AsyncSession):
    """PostgreSQL foreign key (institution_id, campus_id) must reject campus belonging to another institution."""
    inst_a = Institution(code=f"IA_CS_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_CS_{uuid.uuid4().hex[:6]}", name="Inst B")
    db_session.add_all([inst_a, inst_b])
    await db_session.flush()

    campus_b = Campus(institution_id=inst_b.id, code="CB", name="Campus B")
    dept_a = Department(institution_id=inst_a.id, code="DA", name="Dept A")
    term_a = AcademicTerm(
        institution_id=inst_a.id,
        code=f"TA_{uuid.uuid4().hex[:6]}",
        name="Term A",
        academic_year="2026-2027",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
    )
    db_session.add_all([campus_b, dept_a, term_a])
    await db_session.flush()

    # Attempt to insert section in Inst A referencing Campus in Inst B
    cross_section = ClassSection(
        institution_id=inst_a.id,
        campus_id=campus_b.id,
        department_id=dept_a.id,
        academic_term_id=term_a.id,
        section_code="SEC_CROSS_CAMPUS",
        cohort_year=2024,
    )
    db_session.add(cross_section)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "fk_class_sections_inst_campus" in str(exc_info.value).lower() or "foreignkeyviolation" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_rejects_class_section_with_cross_institution_department(db_session: AsyncSession):
    """PostgreSQL foreign key (institution_id, department_id) must reject department belonging to another institution."""
    inst_a = Institution(code=f"IA_CD_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_CD_{uuid.uuid4().hex[:6]}", name="Inst B")
    db_session.add_all([inst_a, inst_b])
    await db_session.flush()

    campus_a = Campus(institution_id=inst_a.id, code="CA", name="Campus A")
    dept_b = Department(institution_id=inst_b.id, code="DB", name="Dept B")
    term_a = AcademicTerm(
        institution_id=inst_a.id,
        code=f"TA_{uuid.uuid4().hex[:6]}",
        name="Term A",
        academic_year="2026-2027",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
    )
    db_session.add_all([campus_a, dept_b, term_a])
    await db_session.flush()

    cross_section = ClassSection(
        institution_id=inst_a.id,
        campus_id=campus_a.id,
        department_id=dept_b.id,
        academic_term_id=term_a.id,
        section_code="SEC_CROSS_DEPT",
        cohort_year=2024,
    )
    db_session.add(cross_section)
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_rejects_class_section_with_cross_institution_academic_term(db_session: AsyncSession):
    """PostgreSQL foreign key (institution_id, academic_term_id) must reject term belonging to another institution."""
    inst_a = Institution(code=f"IA_CT_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_CT_{uuid.uuid4().hex[:6]}", name="Inst B")
    db_session.add_all([inst_a, inst_b])
    await db_session.flush()

    campus_a = Campus(institution_id=inst_a.id, code="CA", name="Campus A")
    dept_a = Department(institution_id=inst_a.id, code="DA", name="Dept A")
    term_b = AcademicTerm(
        institution_id=inst_b.id,
        code=f"TB_{uuid.uuid4().hex[:6]}",
        name="Term B",
        academic_year="2026-2027",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
    )
    db_session.add_all([campus_a, dept_a, term_b])
    await db_session.flush()

    cross_section = ClassSection(
        institution_id=inst_a.id,
        campus_id=campus_a.id,
        department_id=dept_a.id,
        academic_term_id=term_b.id,
        section_code="SEC_CROSS_TERM",
        cohort_year=2024,
    )
    db_session.add(cross_section)
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_rejects_subject_with_cross_institution_department(db_session: AsyncSession):
    """PostgreSQL foreign key (institution_id, department_id) must reject subject referencing cross-institution department."""
    inst_a = Institution(code=f"IA_SD_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_SD_{uuid.uuid4().hex[:6]}", name="Inst B")
    db_session.add_all([inst_a, inst_b])
    await db_session.flush()

    dept_b = Department(institution_id=inst_b.id, code="DB", name="Dept B")
    db_session.add(dept_b)
    await db_session.flush()

    cross_subj = Subject(
        institution_id=inst_a.id,
        department_id=dept_b.id,
        code="CS_CROSS",
        name="Cross Subject",
    )
    db_session.add(cross_subj)
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_rejects_department_campuses_cross_institution(db_session: AsyncSession):
    """PostgreSQL foreign keys on department_campuses must reject linking department in Inst A to campus in Inst B."""
    inst_a = Institution(code=f"IA_DC_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_DC_{uuid.uuid4().hex[:6]}", name="Inst B")
    db_session.add_all([inst_a, inst_b])
    await db_session.flush()

    dept_a = Department(institution_id=inst_a.id, code="DA", name="Dept A")
    campus_b = Campus(institution_id=inst_b.id, code="CB", name="Campus B")
    db_session.add_all([dept_a, campus_b])
    await db_session.flush()

    # Attempting to associate using institution_id = inst_a.id fails on campus_b
    stmt = department_campuses.insert().values(
        institution_id=inst_a.id,
        department_id=dept_a.id,
        campus_id=campus_b.id,
    )
    with pytest.raises(IntegrityError):
        await db_session.execute(stmt)
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_rejects_role_assignment_scope_cross_institution_resource(db_session: AsyncSession):
    """PostgreSQL foreign key (institution_id, department_id) must reject scope pointing to department in another institution."""
    inst_a = Institution(code=f"IA_RAS_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_RAS_{uuid.uuid4().hex[:6]}", name="Inst B")
    user_a = User(institutional_id=f"UA_{uuid.uuid4().hex[:6]}", email=f"ua_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="UA", role=UserRole.FACULTY)
    dept_b = Department(institution_id=inst_b.id, code="DB", name="Dept B")
    db_session.add_all([inst_a, inst_b, user_a, dept_b])
    await db_session.flush()

    membership_a = InstitutionMembership(institution_id=inst_a.id, user_id=user_a.id)
    role = RoleTemplate(code=f"R_{uuid.uuid4().hex[:6]}", name="Role Test", category="TEST")
    db_session.add_all([membership_a, role])
    await db_session.flush()

    assignment_a = RoleAssignment(
        institution_id=inst_a.id,
        membership_id=membership_a.id,
        role_template_id=role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assignment_a)
    await db_session.flush()

    # Scope in Inst A referencing Dept B must be rejected by PostgreSQL itself
    cross_scope = RoleAssignmentScope(
        institution_id=inst_a.id,
        role_assignment_id=assignment_a.id,
        scope_type=RoleScopeType.DEPARTMENT,
        department_id=dept_b.id,
    )
    db_session.add(cross_scope)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "fk_role_scopes_inst_department" in str(exc_info.value).lower() or "foreignkeyviolation" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_rejects_delegation_cross_institution_grantee(db_session: AsyncSession):
    """PostgreSQL foreign key (institution_id, grantee_membership_id) must reject grantee from a different institution."""
    inst_a = Institution(code=f"IA_DEL_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_DEL_{uuid.uuid4().hex[:6]}", name="Inst B")
    user_a = User(institutional_id=f"UA_{uuid.uuid4().hex[:6]}", email=f"ua_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="UA", role=UserRole.FACULTY)
    user_b = User(institutional_id=f"UB_{uuid.uuid4().hex[:6]}", email=f"ub_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="UB", role=UserRole.FACULTY)
    db_session.add_all([inst_a, inst_b, user_a, user_b])
    await db_session.flush()

    membership_a = InstitutionMembership(institution_id=inst_a.id, user_id=user_a.id)
    membership_b = InstitutionMembership(institution_id=inst_b.id, user_id=user_b.id)
    role = RoleTemplate(code=f"R_{uuid.uuid4().hex[:6]}", name="Role Test", category="TEACHING")
    db_session.add_all([membership_a, membership_b, role])
    await db_session.flush()

    assignment_a = RoleAssignment(
        institution_id=inst_a.id,
        membership_id=membership_a.id,
        role_template_id=role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assignment_a)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    # Attempting to create delegation where grantor assignment is in Inst A and grantee membership is in Inst B
    cross_delegation = Delegation(
        institution_id=inst_a.id,
        grantor_role_assignment_id=assignment_a.id,
        grantee_membership_id=membership_b.id,
        valid_from=now,
        valid_until=now + timedelta(days=7),
        reason="Testing cross-institution delegation rejection",
    )
    db_session.add(cross_delegation)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "fk_delegations_inst_grantee" in str(exc_info.value).lower() or "foreignkeyviolation" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_restricts_deletion_of_academic_term_with_sections(db_session: AsyncSession):
    """PostgreSQL ON DELETE RESTRICT prevents accidental deletion of an AcademicTerm that has sections."""
    inst = Institution(code=f"I_DEL_T_{uuid.uuid4().hex[:6]}", name="Inst Del Term")
    db_session.add(inst)
    await db_session.flush()

    campus = Campus(institution_id=inst.id, code="C1", name="C1")
    dept = Department(institution_id=inst.id, code="D1", name="D1")
    term = AcademicTerm(
        institution_id=inst.id,
        code=f"T_{uuid.uuid4().hex[:6]}",
        name="Term 1",
        academic_year="2026",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
    )
    db_session.add_all([campus, dept, term])
    await db_session.flush()

    sec = ClassSection(
        institution_id=inst.id,
        campus_id=campus.id,
        department_id=dept.id,
        academic_term_id=term.id,
        section_code="SEC_HIST",
        cohort_year=2024,
    )
    db_session.add(sec)
    await db_session.flush()

    # Attempting to delete the academic term must be RESTRICTED by PostgreSQL
    await db_session.delete(term)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "fk_class_sections_inst_term" in str(exc_info.value).lower() or "violates foreign key constraint" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_restricts_deletion_of_class_section_with_teaching_assignment(db_session: AsyncSession):
    """PostgreSQL ON DELETE RESTRICT prevents deleting a ClassSection that has teaching assignments."""
    inst = Institution(code=f"I_DEL_SEC_{uuid.uuid4().hex[:6]}", name="Inst Del Sec")
    faculty = User(institutional_id=f"FAC_{uuid.uuid4().hex[:6]}", email=f"fac_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="Fac", role=UserRole.FACULTY)
    db_session.add_all([inst, faculty])
    await db_session.flush()

    campus = Campus(institution_id=inst.id, code="C1", name="C1")
    dept = Department(institution_id=inst.id, code="D1", name="D1")
    term = AcademicTerm(institution_id=inst.id, code=f"T_{uuid.uuid4().hex[:6]}", name="Term", academic_year="2026", start_date=date(2026, 1, 1), end_date=date(2026, 6, 1))
    db_session.add_all([campus, dept, term])
    await db_session.flush()

    sec = ClassSection(institution_id=inst.id, campus_id=campus.id, department_id=dept.id, academic_term_id=term.id, section_code="SEC_TA", cohort_year=2024)
    subj = Subject(institution_id=inst.id, department_id=dept.id, code=f"SBJ_{uuid.uuid4().hex[:6]}", name="Subj")
    db_session.add_all([sec, subj])
    await db_session.flush()

    from src.models.assignment import TeachingAssignment
    ta = TeachingAssignment(
        faculty_user_id=faculty.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=faculty.id,
    )
    db_session.add(ta)
    await db_session.flush()

    # Attempting to delete the section must be RESTRICTED by PostgreSQL
    await db_session.delete(sec)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "teaching_assignments_class_section_id_fkey" in str(exc_info.value).lower() or "violates foreign key constraint" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_rejects_student_scope_with_cross_institution_student(db_session: AsyncSession):
    """PostgreSQL composite FK on role_assignment_scopes(institution_id, student_user_id) rejects student from another institution."""
    inst_a = Institution(code=f"IA_STU_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_STU_{uuid.uuid4().hex[:6]}", name="Inst B")
    user_fac_a = User(institutional_id=f"FA_{uuid.uuid4().hex[:6]}", email=f"fa_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="FA", role=UserRole.FACULTY)
    user_stu_b = User(institutional_id=f"SB_{uuid.uuid4().hex[:6]}", email=f"sb_{uuid.uuid4().hex[:6]}@inst.edu", password_hash="h", full_name="SB", role=UserRole.STUDENT)
    db_session.add_all([inst_a, inst_b, user_fac_a, user_stu_b])
    await db_session.flush()

    m_fac_a = InstitutionMembership(institution_id=inst_a.id, user_id=user_fac_a.id)
    m_stu_b = InstitutionMembership(institution_id=inst_b.id, user_id=user_stu_b.id)  # Student is member of Inst B ONLY
    role = RoleTemplate(code=f"R_ADV_{uuid.uuid4().hex[:6]}", name="Advisor Role", category="ADVISORY")
    db_session.add_all([m_fac_a, m_stu_b, role])
    await db_session.flush()

    assignment_a = RoleAssignment(
        institution_id=inst_a.id,
        membership_id=m_fac_a.id,
        role_template_id=role.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assignment_a)
    await db_session.flush()

    # Attempt to scope assignment in Inst A to student in Inst B
    cross_student_scope = RoleAssignmentScope(
        institution_id=inst_a.id,
        role_assignment_id=assignment_a.id,
        scope_type=RoleScopeType.STUDENT,
        student_user_id=user_stu_b.id,
    )
    db_session.add(cross_student_scope)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "fk_role_scopes_inst_student_membership" in str(exc_info.value).lower() or "violates foreign key constraint" in str(exc_info.value).lower()
    await db_session.rollback()

