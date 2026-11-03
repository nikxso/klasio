from datetime import date
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import TeachingAssignment
from src.models.user import AccountStatus, User, UserRole


@pytest.mark.asyncio
async def test_faculty_assignments_contract(async_client: AsyncClient, db_session: AsyncSession):
    # Setup Faculty user
    faculty = User(
        institutional_id="FAC-CONTRACT-01",
        email="faculty_contract@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Prof Contract",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    admin = User(
        institutional_id="ADM-CONTRACT-01",
        email="admin_contract@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Admin User",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    dept = Department(code="CSE", name="Computer Science")
    term = AcademicTerm(
        code="2026-FALL",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([faculty, admin, dept, term])
    await db_session.flush()

    subject = Subject(code="CS301", name="Data Structures", department_id=dept.id, credits=4)
    section = ClassSection(
        section_code="CSE-3A",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2024,
    )
    db_session.add_all([subject, section])
    await db_session.flush()

    assignment = TeachingAssignment(
        faculty_user_id=faculty.id,
        class_section_id=section.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add(assignment)
    await db_session.flush()

    token = create_access_token(
        subject=str(faculty.id),
        role=faculty.role.value,
        institutional_id=faculty.institutional_id,
    )
    headers = {"Authorization": f"Bearer {token}"}

    # Query GET /api/v1/faculty/assignments
    response = await async_client.get("/api/v1/faculty/assignments", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 1

    item = data[0]
    assert item["teaching_assignment_id"] == str(assignment.id)
    assert item["class_section_id"] == str(section.id)
    assert item["section_code"] == "CSE-3A"
    assert item["subject_code"] == "CS301"
    assert item["subject_name"] == "Data Structures"
    assert item["academic_term_id"] == str(term.id)
    assert item["term_name"] == "Fall 2026"
    assert item["is_delegated"] is False
    assert item["delegation_details"] is None

    # Query GET /api/v1/faculty/assignments/{id}/roster
    roster_res = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date=2026-10-05",
        headers=headers,
    )
    assert roster_res.status_code == 200
    roster_data = roster_res.json()
    assert roster_data["teaching_assignment_id"] == str(assignment.id)
    assert roster_data["session_date"] == "2026-10-05"
    assert "eligible_students" in roster_data
    assert "total_eligible_count" in roster_data
