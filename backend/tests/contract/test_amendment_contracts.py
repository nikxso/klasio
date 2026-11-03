from datetime import date, datetime, timezone
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import TeachingAssignment
from src.models.attendance import (
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
)
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import AccountStatus, User, UserRole


@pytest.fixture
async def amendment_contract_fixture(db_session: AsyncSession):
    # Department & Term
    dept = Department(code="CSE-AMD-CONTRACT", name="Computer Science Dept")
    term = AcademicTerm(
        code="2026-FALL-AMD-C",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS301-AC", name="Data Structures", department_id=dept.id, credits=3)
    section = ClassSection(section_code="CSE-3A-AC", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    db_session.add_all([subject, section])
    await db_session.flush()

    # Regular Faculty
    regular_faculty = User(
        institutional_id="FAC-AMD-REG-01",
        email="fac_amd_reg@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Prof Regular Instructor",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    # Student
    student = User(
        institutional_id="STU-AMD-01",
        email="stu_amd_01@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Student One",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([regular_faculty, student])
    await db_session.flush()

    # Teaching Assignment
    assignment = TeachingAssignment(
        class_section_id=section.id,
        subject_id=subject.id,
        faculty_user_id=regular_faculty.id,
        academic_term_id=term.id,
        created_by_user_id=regular_faculty.id,
        is_active=True,
    )
    # Enrollment
    enrollment = StudentEnrollment(
        student_user_id=student.id,
        class_section_id=section.id,
        academic_term_id=term.id,
        enrollment_status=EnrollmentStatus.ACTIVE,
        effective_start_date=date(2026, 8, 1),
    )
    db_session.add_all([assignment, enrollment])
    await db_session.flush()

    # Finalized Attendance Session (today)
    today = datetime.now(timezone.utc).date()
    now_tz = datetime.now(timezone.utc)
    session = AttendanceSession(
        id=uuid.uuid4(),
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=assignment.id,
        session_date=today,
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        regular_faculty_user_id=regular_faculty.id,
        conducting_faculty_user_id=regular_faculty.id,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_tz,
        records_count=1,
        present_count=0,
        absent_count=1,
        excused_count=0,
    )
    record = AttendanceRecord(
        id=uuid.uuid4(),
        attendance_session_id=session.id,
        student_user_id=student.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now_tz,
    )
    db_session.add_all([session, record])
    await db_session.flush()

    return {
        "faculty": regular_faculty,
        "student": student,
        "session": session,
        "record": record,
    }


@pytest.mark.asyncio
async def test_amendment_contract_schema_and_response(
    async_client: AsyncClient, amendment_contract_fixture: dict
):
    """
    T063: Contract test for POST /api/v1/attendance/sessions/{id}/amendments
    Verifies that the amendment response complies with OpenAPI contract:
    - Status 201 Created
    - Required fields: audit_id, session_id, student_user_id, previous_status, new_status,
      amending_user_id, amendment_role, amendment_reason, amended_at
    - amendment_role matches REGULAR_FACULTY or ADMIN
    """
    ctx = amendment_contract_fixture
    token = create_access_token(
        subject=str(ctx["faculty"].id),
        role=ctx["faculty"].role.value,
        institutional_id=ctx["faculty"].institutional_id,
    )
    headers = {"Authorization": f"Bearer {token}"}

    payload = {
        "student_user_id": str(ctx["student"].id),
        "new_status": "PRESENT",
        "amendment_reason": "Medical certificate verified by department",
    }

    response = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['session'].id}/amendments",
        json=payload,
        headers=headers,
    )

    assert response.status_code == 201
    data = response.json()

    # Validate contract schema fields
    assert "audit_id" in data
    assert uuid.UUID(data["audit_id"])
    assert data["session_id"] == str(ctx["session"].id)
    assert data["student_user_id"] == str(ctx["student"].id)
    assert data["previous_status"] == "ABSENT"
    assert data["new_status"] == "PRESENT"
    assert data["amending_user_id"] == str(ctx["faculty"].id)
    assert data["amendment_role"] == "REGULAR_FACULTY"
    assert data["amendment_reason"] == "Medical certificate verified by department"
    assert "amended_at" in data
    # Ensure valid ISO datetime
    datetime.fromisoformat(data["amended_at"].replace("Z", "+00:00"))


@pytest.mark.asyncio
async def test_amendment_contract_invalid_payload(
    async_client: AsyncClient, amendment_contract_fixture: dict
):
    """
    T063: Contract validation of rejected amendment payloads:
    - Reason shorter than 10 characters -> 422 Unprocessable Entity
    - Transition to identical status -> 400 Bad Request
    """
    ctx = amendment_contract_fixture
    token = create_access_token(
        subject=str(ctx["faculty"].id),
        role=ctx["faculty"].role.value,
        institutional_id=ctx["faculty"].institutional_id,
    )
    headers = {"Authorization": f"Bearer {token}"}

    # 1. Reason too short (< 10 chars)
    short_payload = {
        "student_user_id": str(ctx["student"].id),
        "new_status": "PRESENT",
        "amendment_reason": "Sick",
    }
    short_resp = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['session'].id}/amendments",
        json=short_payload,
        headers=headers,
    )
    assert short_resp.status_code == 422

    # 2. Status transition identical (current status is ABSENT, new_status is ABSENT)
    same_payload = {
        "student_user_id": str(ctx["student"].id),
        "new_status": "ABSENT",
        "amendment_reason": "Re-verifying absence record",
    }
    same_resp = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['session'].id}/amendments",
        json=same_payload,
        headers=headers,
    )
    assert same_resp.status_code == 400


@pytest.mark.asyncio
async def test_amendment_contract_with_client_amendment_id_and_expected_status(
    async_client: AsyncClient, amendment_contract_fixture: dict
):
    """
    Phase 9.1: Contract test verifying client_amendment_id and expected_previous_status:
    - client_amendment_id is accepted in request and returned in response
    - expected_previous_status is accepted in request
    """
    ctx = amendment_contract_fixture
    token = create_access_token(
        subject=str(ctx["faculty"].id),
        role=ctx["faculty"].role.value,
        institutional_id=ctx["faculty"].institutional_id,
    )
    headers = {"Authorization": f"Bearer {token}"}
    client_amd_id = uuid.uuid4()

    payload = {
        "client_amendment_id": str(client_amd_id),
        "student_user_id": str(ctx["student"].id),
        "expected_previous_status": "ABSENT",
        "new_status": "PRESENT",
        "amendment_reason": "Medical certificate verified by department",
    }

    response = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['session'].id}/amendments",
        json=payload,
        headers=headers,
    )

    assert response.status_code == 201
    data = response.json()
    assert "client_amendment_id" in data
    assert data["client_amendment_id"] == str(client_amd_id)

