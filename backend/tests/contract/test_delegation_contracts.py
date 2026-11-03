from datetime import date, timedelta
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import TeachingAssignment
from src.models.user import AccountStatus, User, UserRole


@pytest.mark.asyncio
async def test_create_and_revoke_delegation_contract(
    async_client: AsyncClient, db_session: AsyncSession
):
    """
    T040: Contract tests for substitute delegation creation and revocation.
    Validates request/response schemas for:
    - POST /api/v1/faculty/assignments/{id}/delegations
    - POST /api/v1/faculty/delegations/{id}/revoke
    """
    # 1. Setup Admin, Regular Faculty, and Substitute Faculty
    admin = User(
        institutional_id="ADM-DEL-01",
        email="admin_del@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Admin Del",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_a = User(
        institutional_id="FAC-DEL-A",
        email="faculty_a@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Dr. Regular Faculty A",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_b = User(
        institutional_id="FAC-DEL-B",
        email="faculty_b@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Prof. Colleague B",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, faculty_a, faculty_b])
    await db_session.flush()

    # 2. Setup Academic Structure & Assignment
    dept = Department(code="CSE-DEL", name="Computer Science Delegation")
    term = AcademicTerm(
        code="2026-FALL-DEL",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS304", name="Algorithms", department_id=dept.id, credits=4)
    section = ClassSection(
        section_code="CSE-3D",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2024,
    )
    db_session.add_all([subject, section])
    await db_session.flush()

    assignment = TeachingAssignment(
        faculty_user_id=faculty_a.id,
        class_section_id=section.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add(assignment)
    await db_session.flush()

    token_a = create_access_token(
        subject=str(faculty_a.id),
        role=faculty_a.role.value,
        institutional_id=faculty_a.institutional_id,
    )
    headers_a = {"Authorization": f"Bearer {token_a}"}

    # 3. Contract: Create delegation
    start = date.today()
    end = start + timedelta(days=3)
    create_payload = {
        "substitute_faculty_user_id": str(faculty_b.id),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "delegation_reason": "Attending IEEE research conference in Boston",
    }

    res = await async_client.post(
        f"/api/v1/faculty/assignments/{assignment.id}/delegations",
        json=create_payload,
        headers=headers_a,
    )
    assert res.status_code == 201
    del_data = res.json()

    assert del_data["teaching_assignment_id"] == str(assignment.id)
    assert del_data["regular_faculty_user_id"] == str(faculty_a.id)
    assert del_data["substitute_faculty_user_id"] == str(faculty_b.id)
    assert del_data["start_date"] == start.isoformat()
    assert del_data["end_date"] == end.isoformat()
    assert del_data["delegation_reason"] == create_payload["delegation_reason"]
    assert del_data["status"] == "ACTIVE"
    assert "id" in del_data
    delegation_id = del_data["id"]

    # 4. Contract: Self-delegation rejection
    self_del_payload = {
        "substitute_faculty_user_id": str(faculty_a.id),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "delegation_reason": "Self delegation attempt",
    }
    self_res = await async_client.post(
        f"/api/v1/faculty/assignments/{assignment.id}/delegations",
        json=self_del_payload,
        headers=headers_a,
    )
    assert self_res.status_code == 400

    # 5. Contract: Revoke delegation
    revoke_payload = {
        "revocation_reason": "Returned early from conference",
    }
    revoke_res = await async_client.post(
        f"/api/v1/faculty/delegations/{delegation_id}/revoke",
        json=revoke_payload,
        headers=headers_a,
    )
    assert revoke_res.status_code == 200
    revoked_data = revoke_res.json()
    assert revoked_data["status"] == "REVOKED"
    assert revoked_data["revocation_reason"] == "Returned early from conference"
    assert revoked_data["revoked_at"] is not None
