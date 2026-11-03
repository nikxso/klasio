from datetime import date
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.user import AccountStatus, User, UserRole


@pytest.mark.asyncio
async def test_faculty_scoping_and_out_of_scope_rejection(async_client: AsyncClient, db_session: AsyncSession):
    # 1. Create 3 Faculty users and 1 Admin
    admin = User(
        institutional_id="ADM-SCOPE-01",
        email="admin_scope@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Admin Admin",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_a = User(
        institutional_id="FAC-SCOPE-A",
        email="faculty_a@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof A (Section 3A)",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_b = User(
        institutional_id="FAC-SCOPE-B",
        email="faculty_b@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof B (Section 3B)",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_c = User(
        institutional_id="FAC-SCOPE-C",
        email="faculty_c@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof C (Unassigned)",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    dept = Department(code="CSE-SCOPE", name="Computer Science Dept")
    term = AcademicTerm(
        code="2026-FALL-SCOPE",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([admin, faculty_a, faculty_b, faculty_c, dept, term])
    await db_session.flush()

    subject = Subject(code="CS301-S", name="Data Structures", department_id=dept.id, credits=3)
    section_3a = ClassSection(section_code="CSE-3A", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    section_3b = ClassSection(section_code="CSE-3B", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    db_session.add_all([subject, section_3a, section_3b])
    await db_session.flush()

    # Assignment 1: Faculty A -> Section 3A
    assign_a = TeachingAssignment(
        faculty_user_id=faculty_a.id,
        class_section_id=section_3a.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    # Assignment 2: Faculty B -> Section 3B
    assign_b = TeachingAssignment(
        faculty_user_id=faculty_b.id,
        class_section_id=section_3b.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add_all([assign_a, assign_b])
    await db_session.flush()

    token_a = create_access_token(subject=str(faculty_a.id), role="FACULTY", institutional_id=faculty_a.institutional_id)
    token_b = create_access_token(subject=str(faculty_b.id), role="FACULTY", institutional_id=faculty_b.institutional_id)
    token_c = create_access_token(subject=str(faculty_c.id), role="FACULTY", institutional_id=faculty_c.institutional_id)

    headers_a = {"Authorization": f"Bearer {token_a}"}
    headers_b = {"Authorization": f"Bearer {token_b}"}
    headers_c = {"Authorization": f"Bearer {token_c}"}

    # Test 1: Faculty A can access Section 3A roster
    res = await async_client.get(f"/api/v1/faculty/assignments/{assign_a.id}/roster?session_date=2026-10-05", headers=headers_a)
    assert res.status_code == 200

    # Test 2: Faculty A CANNOT access Section 3B roster (HTTP 403 OUT_OF_SCOPE)
    res = await async_client.get(f"/api/v1/faculty/assignments/{assign_b.id}/roster?session_date=2026-10-05", headers=headers_a)
    assert res.status_code == 403
    assert res.json()["error"] == "OUT_OF_SCOPE"

    # Test 3: Faculty B CANNOT access Section 3A roster (HTTP 403 OUT_OF_SCOPE)
    res = await async_client.get(f"/api/v1/faculty/assignments/{assign_a.id}/roster?session_date=2026-10-05", headers=headers_b)
    assert res.status_code == 403
    assert res.json()["error"] == "OUT_OF_SCOPE"

    # Test 4: Faculty C (unassigned) CANNOT access either section
    res = await async_client.get(f"/api/v1/faculty/assignments/{assign_a.id}/roster?session_date=2026-10-05", headers=headers_c)
    assert res.status_code == 403
    res = await async_client.get(f"/api/v1/faculty/assignments/{assign_b.id}/roster?session_date=2026-10-05", headers=headers_c)
    assert res.status_code == 403

    # Test 5: Temporary Substitute Delegation
    # Faculty A delegates Section 3A to Faculty B for Oct 1 to Oct 10
    delegation = SubstituteDelegation(
        teaching_assignment_id=assign_a.id,
        regular_faculty_user_id=faculty_a.id,
        substitute_faculty_user_id=faculty_b.id,
        created_by_user_id=faculty_a.id,
        start_date=date(2026, 10, 1),
        end_date=date(2026, 10, 10),
        delegation_reason="Attending academic conference",
        status=DelegationStatus.ACTIVE,
    )
    db_session.add(delegation)
    await db_session.flush()

    # During delegation window (Oct 5), Faculty B CAN access Section 3A
    res = await async_client.get(f"/api/v1/faculty/assignments/{assign_a.id}/roster?session_date=2026-10-05", headers=headers_b)
    assert res.status_code == 200

    # Outside delegation window (Oct 15), Faculty B is BLOCKED with HTTP 403
    res = await async_client.get(f"/api/v1/faculty/assignments/{assign_a.id}/roster?session_date=2026-10-15", headers=headers_b)
    assert res.status_code == 403
    assert res.json()["error"] == "OUT_OF_SCOPE"
