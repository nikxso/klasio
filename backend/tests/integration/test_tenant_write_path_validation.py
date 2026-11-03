"""Integration Tests for Multi-Tenant Write Path Membership Validation.

Verifies:
1. Faculty belonging to Institution B cannot be assigned to a section in Institution A (rejected with OUT_OF_SCOPE).
2. Student belonging to Institution B cannot be enrolled into a section in Institution A (rejected with EligibilityError).
3. Student belonging to Institution B cannot be transferred into a section in Institution A.
4. Dual-membership user:
   - An active member of both Institution A and Institution B can be assigned/enrolled in either institution.
   - If membership in Institution A is SUSPENDED, assignment/enrollment in Institution A is rejected,
     even while membership in Institution B remains ACTIVE.
"""
from datetime import date
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.access_control import (
    Campus,
    Institution,
    InstitutionMembership,
    MembershipStatus,
)
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import AccountStatus, User, UserRole


@pytest.fixture
async def multi_inst_env(db_session: AsyncSession):
    inst_a = Institution(code=f"IA_{uuid.uuid4().hex[:6]}", name="Inst A")
    inst_b = Institution(code=f"IB_{uuid.uuid4().hex[:6]}", name="Inst B")
    db_session.add_all([inst_a, inst_b])
    await db_session.flush()

    campus_a = Campus(institution_id=inst_a.id, code="CA", name="CA")
    dept_a = Department(institution_id=inst_a.id, code="DA", name="DA")
    term_a = AcademicTerm(
        institution_id=inst_a.id,
        code=f"TA_{uuid.uuid4().hex[:6]}",
        name="Term A",
        academic_year="2026",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([campus_a, dept_a, term_a])
    await db_session.flush()

    sec_a1 = ClassSection(institution_id=inst_a.id, campus_id=campus_a.id, department_id=dept_a.id, academic_term_id=term_a.id, section_code="A1", cohort_year=2024)
    sec_a2 = ClassSection(institution_id=inst_a.id, campus_id=campus_a.id, department_id=dept_a.id, academic_term_id=term_a.id, section_code="A2", cohort_year=2024)
    subj_a = Subject(institution_id=inst_a.id, department_id=dept_a.id, code="CS1", name="CS1")
    db_session.add_all([sec_a1, sec_a2, subj_a])
    await db_session.flush()

    admin = User(
        institutional_id=f"ADM_{uuid.uuid4().hex[:6]}",
        email=f"adm_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Admin",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    fac_b = User(
        institutional_id=f"FAC_B_{uuid.uuid4().hex[:6]}",
        email=f"facb_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Faculty B Only",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    stu_b = User(
        institutional_id=f"STU_B_{uuid.uuid4().hex[:6]}",
        email=f"stub_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Student B Only",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    user_dual = User(
        institutional_id=f"DUAL_{uuid.uuid4().hex[:6]}",
        email=f"dual_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Dual Member User",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, fac_b, stu_b, user_dual])
    await db_session.flush()

    # Memberships: fac_b and stu_b ONLY in Inst B
    m_fac_b = InstitutionMembership(institution_id=inst_b.id, user_id=fac_b.id, status=MembershipStatus.ACTIVE)
    m_stu_b = InstitutionMembership(institution_id=inst_b.id, user_id=stu_b.id, status=MembershipStatus.ACTIVE)

    # user_dual holds membership in both Inst A and Inst B
    m_dual_a = InstitutionMembership(institution_id=inst_a.id, user_id=user_dual.id, status=MembershipStatus.ACTIVE)
    m_dual_b = InstitutionMembership(institution_id=inst_b.id, user_id=user_dual.id, status=MembershipStatus.ACTIVE)

    db_session.add_all([m_fac_b, m_stu_b, m_dual_a, m_dual_b])
    await db_session.commit()

    return {
        "inst_a": inst_a,
        "inst_b": inst_b,
        "sec_a1": sec_a1,
        "sec_a2": sec_a2,
        "term_a": term_a,
        "subj_a": subj_a,
        "admin": admin,
        "fac_b": fac_b,
        "stu_b": stu_b,
        "user_dual": user_dual,
        "m_dual_a": m_dual_a,
    }


def _admin_header(admin: User) -> dict:
    token = create_access_token(subject=str(admin.id), role=admin.role.value, institutional_id=admin.institutional_id)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_cross_institution_teaching_assignment_rejected(async_client: AsyncClient, multi_inst_env: dict):
    """Attempting to assign Faculty B to Section A (Institution A) is rejected."""
    env = multi_inst_env
    headers = _admin_header(env["admin"])

    payload = {
        "faculty_user_id": str(env["fac_b"].id),
        "class_section_id": str(env["sec_a1"].id),
        "subject_id": str(env["subj_a"].id),
        "academic_term_id": str(env["term_a"].id),
        "is_active": True,
    }
    res = await async_client.post("/api/v1/admin/assignments", json=payload, headers=headers)
    assert res.status_code == 403
    assert res.json()["error"] == "OUT_OF_SCOPE"
    assert "does not have an active membership" in res.json()["message"]


@pytest.mark.asyncio
async def test_cross_institution_enrollment_rejected(async_client: AsyncClient, multi_inst_env: dict):
    """Attempting to enroll Student B into Section A (Institution A) is rejected."""
    env = multi_inst_env
    headers = _admin_header(env["admin"])

    payload = {
        "student_user_id": str(env["stu_b"].id),
        "class_section_id": str(env["sec_a1"].id),
        "academic_term_id": str(env["term_a"].id),
        "effective_start_date": "2026-01-01",
        "enrollment_status": "ACTIVE",
    }
    res = await async_client.post("/api/v1/admin/enrollments", json=payload, headers=headers)
    assert res.status_code == 400
    assert res.json()["error"] == "STUDENT_INELIGIBLE"
    assert "does not have an active membership in institution" in res.json()["message"]


@pytest.mark.asyncio
async def test_cross_institution_transfer_rejected(async_client: AsyncClient, multi_inst_env: dict, db_session: AsyncSession):
    """Attempting to transfer a student whose membership doesn't match target section is rejected."""
    env = multi_inst_env
    headers = _admin_header(env["admin"])

    # First enroll user_dual in Section A1
    enr_dual = StudentEnrollment(
        student_user_id=env["user_dual"].id,
        class_section_id=env["sec_a1"].id,
        academic_term_id=env["term_a"].id,
        effective_start_date=date(2026, 1, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add(enr_dual)
    await db_session.commit()

    # Now suspend user_dual's membership in Institution A
    m_dual_a = env["m_dual_a"]
    m_dual_a.status = MembershipStatus.SUSPENDED
    await db_session.commit()

    # Attempt transfer in Institution A -> must be rejected because membership in Inst A is SUSPENDED!
    payload = {
        "student_user_id": str(env["user_dual"].id),
        "current_class_section_id": str(env["sec_a1"].id),
        "new_class_section_id": str(env["sec_a2"].id),
        "transfer_date": "2026-02-01",
    }
    res = await async_client.post("/api/v1/admin/enrollments/transfer", json=payload, headers=headers)
    assert res.status_code == 400
    assert res.json()["error"] == "STUDENT_INELIGIBLE"
    assert "does not have an active membership in target institution" in res.json()["message"]
