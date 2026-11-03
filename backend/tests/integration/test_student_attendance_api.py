"""
Integration tests for Student Attendance History & Shortage Guidance:
- GET /api/v1/student/attendance (Overview with shortage metrics)
- GET /api/v1/student/subjects/{teaching_assignment_id}/history (Chronological session records)
- Strict cross-student data isolation & role boundaries
- Date-bounded session applicability (enrollment interval filtering)
- CANCELLED & EXEMPT session denominator exclusions
- Shortage intelligence calculations: recovery classes, margin to miss, and unreachable threshold handling
"""

from datetime import date, datetime, timedelta, timezone
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
async def student_api_env(db_session: AsyncSession) -> dict:
    """Setup academic hierarchy, users, assignments, enrollments, and sessions."""
    # 1. Users
    student_a = User(
        institutional_id="STU-PH14-A",
        email="student_a@institution.edu",
        password_hash=get_password_hash("password"),
        full_name="Student Alice",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    student_b = User(
        institutional_id="STU-PH14-B",
        email="student_b@institution.edu",
        password_hash=get_password_hash("password"),
        full_name="Student Bob",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    faculty = User(
        institutional_id="FAC-PH14-01",
        email="faculty_ph14@institution.edu",
        password_hash=get_password_hash("password"),
        full_name="Prof Katherine Johnson",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    admin = User(
        institutional_id="ADM-PH14-01",
        email="admin_ph14@institution.edu",
        password_hash=get_password_hash("password"),
        full_name="Dean Administrator",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([student_a, student_b, faculty, admin])
    await db_session.flush()

    # 2. Academic structure
    dept = Department(name="Computer Science & Engineering", code="CSE-PH14")
    db_session.add(dept)
    await db_session.flush()

    term = AcademicTerm(
        code="AUT-2026-PH14",
        name="Autumn 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 20),
        status=TermStatus.ACTIVE,
    )
    db_session.add(term)
    await db_session.flush()

    sec_a = ClassSection(
        department_id=dept.id,
        academic_term_id=term.id,
        section_code="CSE-4A",
        cohort_year=2026,
    )
    sec_b = ClassSection(
        department_id=dept.id,
        academic_term_id=term.id,
        section_code="CSE-4B",
        cohort_year=2026,
    )
    db_session.add_all([sec_a, sec_b])
    await db_session.flush()

    subj_cs401 = Subject(department_id=dept.id, code="CS401", name="Distributed Systems", credits=4)
    subj_cs402 = Subject(department_id=dept.id, code="CS402", name="Database Internals", credits=4)
    db_session.add_all([subj_cs401, subj_cs402])
    await db_session.flush()

    # Section A has CS401 (taught by faculty)
    ta_cs401 = TeachingAssignment(
        class_section_id=sec_a.id,
        subject_id=subj_cs401.id,
        faculty_user_id=faculty.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    # Section B has CS402 (taught by faculty)
    ta_cs402 = TeachingAssignment(
        class_section_id=sec_b.id,
        subject_id=subj_cs402.id,
        faculty_user_id=faculty.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add_all([ta_cs401, ta_cs402])
    await db_session.flush()

    # Enrollments: Student A in Sec A (starting Sept 1), Student B in Sec B
    enr_a = StudentEnrollment(
        student_user_id=student_a.id,
        class_section_id=sec_a.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 9, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    enr_b = StudentEnrollment(
        student_user_id=student_b.id,
        class_section_id=sec_b.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 9, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add_all([enr_a, enr_b])
    await db_session.flush()

    # Now create attendance sessions in CS401 (Section A)
    now = datetime.now(timezone.utc)

    # Session 0: Held in August (BEFORE Student A's effective_start_date) -> should be excluded!
    sess_prior = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_cs401.id,
        session_date=date(2026, 8, 25),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
        finalized_at=now,
    )
    db_session.add(sess_prior)
    await db_session.flush()

    rec_prior_a = AttendanceRecord(
        attendance_session_id=sess_prior.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now,
    )
    db_session.add(rec_prior_a)

    # Session 1: Sept 10 (COUNTED) -> Student A PRESENT
    sess_1 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_cs401.id,
        session_date=date(2026, 9, 10),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
        finalized_at=now,
    )
    db_session.add(sess_1)
    await db_session.flush()

    rec_1_a = AttendanceRecord(
        attendance_session_id=sess_1.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.PRESENT,
        mark_source=MarkSource.AI_VERIFIED,
        candidate_confidence=0.98,
        recorded_at=now,
    )
    db_session.add(rec_1_a)

    # Session 2: Sept 17 (COUNTED) -> Student A ABSENT
    sess_2 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_cs401.id,
        session_date=date(2026, 9, 17),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
        finalized_at=now,
    )
    db_session.add(sess_2)
    await db_session.flush()

    rec_2_a = AttendanceRecord(
        attendance_session_id=sess_2.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now,
    )
    db_session.add(rec_2_a)

    # Session 3: Sept 24 (CANCELLED - Campus flood) -> Excluded from denominator!
    sess_3 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_cs401.id,
        session_date=date(2026, 9, 24),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.CANCELLED,
        status_reason="Severe storm and campus flood",
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
        finalized_at=now,
    )
    db_session.add(sess_3)
    await db_session.flush()

    rec_3_a = AttendanceRecord(
        attendance_session_id=sess_3.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.EXCUSED,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now,
    )
    db_session.add(rec_3_a)

    # Session 4: Oct 01 (COUNTED) -> Student A ABSENT
    sess_4 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_cs401.id,
        session_date=date(2026, 10, 1),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
        finalized_at=now,
    )
    db_session.add(sess_4)
    await db_session.flush()

    rec_4_a = AttendanceRecord(
        attendance_session_id=sess_4.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now,
    )
    db_session.add(rec_4_a)

    # Session 5: Oct 08 (COUNTED) -> Student A ABSENT
    sess_5 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_cs401.id,
        session_date=date(2026, 10, 8),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
        finalized_at=now,
    )
    db_session.add(sess_5)
    await db_session.flush()

    rec_5_a = AttendanceRecord(
        attendance_session_id=sess_5.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now,
    )
    db_session.add(rec_5_a)

    await db_session.commit()

    token_a = create_access_token(subject=str(student_a.id), role=student_a.role.value, institutional_id=student_a.institutional_id)
    token_b = create_access_token(subject=str(student_b.id), role=student_b.role.value, institutional_id=student_b.institutional_id)
    token_faculty = create_access_token(subject=str(faculty.id), role=faculty.role.value, institutional_id=faculty.institutional_id)

    return {
        "student_a": student_a,
        "student_b": student_b,
        "faculty": faculty,
        "term": term,
        "sec_a": sec_a,
        "sec_b": sec_b,
        "ta_cs401": ta_cs401,
        "ta_cs402": ta_cs402,
        "token_a": token_a,
        "token_b": token_b,
        "token_faculty": token_faculty,
    }


@pytest.mark.anyio
async def test_student_personal_attendance_overview(async_client: AsyncClient, student_api_env: dict):
    """
    Test GET /api/v1/student/attendance:
    - Bounded by effective_start_date (excludes Aug session)
    - Excludes CANCELLED session from denominator
    - Counted eligible sessions = 4 (Sept 10, 17, Oct 1, Oct 8)
    - Attended = 1 (Sept 10)
    - Percentage = 25.0%
    - Shortage = True (threshold 75.0%)
    - Recovery classes = ceil((75*4 - 100*1)/(100 - 75)) = ceil((300 - 100)/25) = 8
    """
    headers = {"Authorization": f"Bearer {student_api_env['token_a']}"}
    response = await async_client.get("/api/v1/student/attendance", headers=headers)
    assert response.status_code == 200

    data = response.json()
    assert data["student_id"] == str(student_api_env["student_a"].id)
    assert len(data["subjects"]) == 1

    subj = data["subjects"][0]
    assert subj["teaching_assignment_id"] == str(student_api_env["ta_cs401"].id)
    assert subj["subject_code"] == "CS401"
    assert subj["subject_name"] == "Distributed Systems"
    assert subj["faculty_name"] == "Prof Katherine Johnson"
    assert subj["total_eligible_sessions"] == 4
    assert subj["attended_sessions"] == 1
    assert subj["attendance_percentage"] == 25.0
    assert subj["is_shortage"] is True
    assert subj["classes_to_recover"] == 8
    assert subj["classes_can_miss"] == 0
    assert subj["is_recoverable"] is True
    assert subj["threshold"] == 75.0


@pytest.mark.anyio
async def test_student_subject_history_chronological_records(async_client: AsyncClient, student_api_env: dict):
    """
    Test GET /api/v1/student/subjects/{teaching_assignment_id}/history:
    - Returns chronological history (newest first)
    - Bounded by enrollment date (excludes Aug session)
    - Includes the CANCELLED session with status_reason
    - Contains correct statuses and mark sources
    """
    ta_id = student_api_env["ta_cs401"].id
    headers = {"Authorization": f"Bearer {student_api_env['token_a']}"}
    response = await async_client.get(f"/api/v1/student/subjects/{ta_id}/history", headers=headers)
    assert response.status_code == 200

    data = response.json()
    assert data["teaching_assignment_id"] == str(ta_id)
    assert data["subject_code"] == "CS401"
    assert data["total_eligible_sessions"] == 4
    assert data["attended_sessions"] == 1
    assert data["attendance_percentage"] == 25.0
    assert data["is_shortage"] is True
    assert data["classes_to_recover"] == 8

    # 5 sessions within interval: Oct 8, Oct 1, Sept 24 (cancelled), Sept 17, Sept 10
    records = data["records"]
    assert len(records) == 5

    # Check newest session first
    assert records[0]["session_date"] == "2026-10-08"
    assert records[0]["attendance_status"] == "ABSENT"
    assert records[0]["applicability_status"] == "COUNTED"

    # Check cancelled session with reason
    cancelled_sess = next(r for r in records if r["session_date"] == "2026-09-24")
    assert cancelled_sess["applicability_status"] == "CANCELLED"
    assert cancelled_sess["status_reason"] == "Severe storm and campus flood"

    # Check present session
    present_sess = next(r for r in records if r["session_date"] == "2026-09-10")
    assert present_sess["attendance_status"] == "PRESENT"
    assert present_sess["mark_source"] == "AI_VERIFIED"


@pytest.mark.anyio
async def test_cross_student_isolation(async_client: AsyncClient, student_api_env: dict):
    """
    Verify security and privacy invariant SC-008:
    - Student A cannot access Student B's subject history (not enrolled in CS402) -> 404
    - Student B cannot access Student A's subject history (not enrolled in CS401) -> 404
    """
    # Student A attempting to inspect CS402 (enrolled only in CS401)
    ta_cs402_id = student_api_env["ta_cs402"].id
    headers_a = {"Authorization": f"Bearer {student_api_env['token_a']}"}
    res_a = await async_client.get(f"/api/v1/student/subjects/{ta_cs402_id}/history", headers=headers_a)
    assert res_a.status_code == 404

    # Student B attempting to inspect CS401 (enrolled only in CS402)
    ta_cs401_id = student_api_env["ta_cs401"].id
    headers_b = {"Authorization": f"Bearer {student_api_env['token_b']}"}
    res_b = await async_client.get(f"/api/v1/student/subjects/{ta_cs401_id}/history", headers=headers_b)
    assert res_b.status_code == 404


@pytest.mark.anyio
async def test_student_endpoints_role_boundary(async_client: AsyncClient, student_api_env: dict):
    """
    Verify role enforcement:
    - Faculty cannot access student personal endpoints (403)
    - Unauthenticated cannot access student endpoints (401)
    """
    headers_faculty = {"Authorization": f"Bearer {student_api_env['token_faculty']}"}
    ta_id = student_api_env["ta_cs401"].id

    # Overview
    res_fac_overview = await async_client.get("/api/v1/student/attendance", headers=headers_faculty)
    assert res_fac_overview.status_code == 403

    # History
    res_fac_hist = await async_client.get(f"/api/v1/student/subjects/{ta_id}/history", headers=headers_faculty)
    assert res_fac_hist.status_code == 403

    # Unauthenticated
    res_unauth = await async_client.get("/api/v1/student/attendance")
    assert res_unauth.status_code == 401


@pytest.mark.anyio
async def test_student_history_unreachable_threshold(student_api_env: dict, db_session: AsyncSession):
    """
    Verify shortage edge case: When threshold is 100.0% and student was absent in at least one held session,
    100% attendance is mathematically impossible to achieve.
    classes_to_recover must be None, and is_recoverable must be False (no negative numbers or broken math).
    """
    from src.services.enrollment_service import EnrollmentService
    service = EnrollmentService(db_session)
    ta_id = student_api_env["ta_cs401"].id
    student_id = student_api_env["student_a"].id

    history = await service.get_student_subject_history(
        student_user_id=student_id,
        teaching_assignment_id=ta_id,
        threshold=100.0,
    )
    assert history.threshold == 100.0
    assert history.total_eligible_sessions == 4
    assert history.attended_sessions == 1
    assert history.classes_to_recover is None
    assert history.is_recoverable is False
    assert history.is_shortage is True


@pytest.mark.anyio
async def test_student_zero_eligible_sessions(async_client: AsyncClient, student_api_env: dict):
    """
    Verify edge case: Student B enrolled in Section B with zero attendance sessions held.
    - total_eligible_sessions = 0
    - attended_sessions = 0
    - attendance_percentage = 100.0 (or neutral clean default)
    - is_shortage = False
    - classes_to_recover = 0
    - classes_can_miss = 0
    """
    headers = {"Authorization": f"Bearer {student_api_env['token_b']}"}
    ta_id = student_api_env["ta_cs402"].id

    res = await async_client.get(f"/api/v1/student/subjects/{ta_id}/history", headers=headers)
    assert res.status_code == 200
    data = res.json()

    assert data["total_eligible_sessions"] == 0
    assert data["attended_sessions"] == 0
    assert data["attendance_percentage"] == 100.0
    assert data["is_shortage"] is False
    assert data["classes_to_recover"] == 0
    assert data["classes_can_miss"] == 0
    assert data["records"] == []
