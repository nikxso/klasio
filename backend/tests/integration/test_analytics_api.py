"""
Integration tests for Attendance Analytics & Intelligence API:
- GET /api/v1/analytics/overview (Role-scoping for Admin, Faculty, and Student)
- GET /api/v1/analytics/assignments/{teaching_assignment_id} (Scoping, permissions, and calculations)
- Strict access control: Student forbidden on section endpoint (403), unauthorized faculty (403 OUT_OF_SCOPE)
- Active substitute delegation granting section access (200)
- Shortage intelligence: recovery classes calculation, allowed absences, denominator filtering
"""

from datetime import date, datetime, timedelta, timezone
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
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
async def analytics_api_env(db_session: AsyncSession) -> dict:
    """Setup academic hierarchy, users, assignments, sessions, and records."""
    # 1. Users
    admin = User(
        institutional_id="ADM-INT-01",
        email="admin_int@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Director Administrator",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    fac_1 = User(
        institutional_id="FAC-INT-01",
        email="fac1_int@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Ada Lovelace",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_2 = User(
        institutional_id="FAC-INT-02",
        email="fac2_int@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Alan Turing",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_unassigned = User(
        institutional_id="FAC-INT-03",
        email="fac3_int@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Charles Babbage",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student_shortage = User(
        institutional_id="STU-INT-01",
        email="stu1_int@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Grace Hopper (Shortage)",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    student_good = User(
        institutional_id="STU-INT-02",
        email="stu2_int@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Claude Shannon (Good Standing)",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, fac_1, fac_2, fac_unassigned, student_shortage, student_good])
    await db_session.flush()

    # 2. Academic structure
    dept = Department(code="CSE-INT", name="Computer Science & Engineering")
    term = AcademicTerm(
        code="2026-FALL-INT",
        name="Fall 2026 Analytics Term",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    sub_cs101 = Subject(code="CS101", name="Intro to Algorithms", department_id=dept.id, credits=4)
    sub_cs102 = Subject(code="CS102", name="Operating Systems", department_id=dept.id, credits=3)
    sec_a = ClassSection(section_code="CSE-A", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    sec_b = ClassSection(section_code="CSE-B", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    db_session.add_all([sub_cs101, sub_cs102, sec_a, sec_b])
    await db_session.flush()

    # 3. Teaching Assignments
    # Assignment A: fac_1 teaches CS101 to Section A
    ta_a = TeachingAssignment(
        faculty_user_id=fac_1.id,
        class_section_id=sec_a.id,
        subject_id=sub_cs101.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    # Assignment B: fac_2 teaches CS102 to Section B
    ta_b = TeachingAssignment(
        faculty_user_id=fac_2.id,
        class_section_id=sec_b.id,
        subject_id=sub_cs102.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add_all([ta_a, ta_b])
    await db_session.flush()

    # 4. Enrollments
    # Both students in Section A for Fall 2026
    enr_1 = StudentEnrollment(
        student_user_id=student_shortage.id,
        class_section_id=sec_a.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 1),
        effective_end_date=None,
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    enr_2 = StudentEnrollment(
        student_user_id=student_good.id,
        class_section_id=sec_a.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 1),
        effective_end_date=None,
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add_all([enr_1, enr_2])
    await db_session.flush()

    # 5. Substitute Delegation: fac_1 delegates Assignment A to fac_2 today
    today = date.today()
    delegation = SubstituteDelegation(
        teaching_assignment_id=ta_a.id,
        regular_faculty_user_id=fac_1.id,
        substitute_faculty_user_id=fac_2.id,
        created_by_user_id=fac_1.id,
        start_date=today - timedelta(days=2),
        end_date=today + timedelta(days=5),
        delegation_reason="Guest Lecture Series",
        status=DelegationStatus.ACTIVE,
    )
    db_session.add(delegation)
    await db_session.flush()

    # 6. Sessions for Assignment A:
    # 4 COUNTED sessions, 1 CANCELLED session, 1 EXEMPT session
    now_utc = datetime.now(timezone.utc)
    base_date = today - timedelta(days=10)

    # Session 1 (COUNTED)
    s1 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=base_date,
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_utc,
        regular_faculty_user_id=fac_1.id,
        conducting_faculty_user_id=fac_1.id,
    )
    # Session 2 (COUNTED)
    s2 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=base_date + timedelta(days=1),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_utc,
        regular_faculty_user_id=fac_1.id,
        conducting_faculty_user_id=fac_1.id,
    )
    # Session 3 (CANCELLED)
    s3 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=base_date + timedelta(days=2),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.CANCELLED,
        status_reason="Weather Alert",
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_utc,
        regular_faculty_user_id=fac_1.id,
        conducting_faculty_user_id=fac_1.id,
    )
    # Session 4 (COUNTED)
    s4 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=base_date + timedelta(days=3),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_utc,
        regular_faculty_user_id=fac_1.id,
        conducting_faculty_user_id=fac_1.id,
    )
    # Session 5 (EXEMPT)
    s5 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=base_date + timedelta(days=4),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.EXEMPT,
        status_reason="Campus Hackathon",
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_utc,
        regular_faculty_user_id=fac_1.id,
        conducting_faculty_user_id=fac_1.id,
    )
    # Session 6 (COUNTED)
    s6 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=base_date + timedelta(days=5),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_utc,
        regular_faculty_user_id=fac_1.id,
        conducting_faculty_user_id=fac_1.id,
    )
    db_session.add_all([s1, s2, s3, s4, s5, s6])
    await db_session.flush()

    # Attendance Records for COUNTED sessions (s1, s2, s4, s6):
    # Total counted sessions = 4
    # Student Shortage:
    #   s1: PRESENT
    #   s2: ABSENT
    #   s4: ABSENT
    #   s6: ABSENT
    # -> Attended = 1, Held = 4 -> 25.0% (<75%), Consecutive absences = 3 (s6, s4, s2)
    # Student Good:
    #   s1: PRESENT
    #   s2: PRESENT
    #   s4: PRESENT
    #   s6: PRESENT
    # -> Attended = 4, Held = 4 -> 100.0% (>=75%), Consecutive absences = 0

    records = [
        # s1
        AttendanceRecord(
            attendance_session_id=s1.id,
            student_user_id=student_shortage.id,
            attendance_status=AttendanceStatus.PRESENT,
            recorded_at=now_utc,
        ),
        AttendanceRecord(
            attendance_session_id=s1.id,
            student_user_id=student_good.id,
            attendance_status=AttendanceStatus.PRESENT,
            recorded_at=now_utc,
        ),
        # s2
        AttendanceRecord(
            attendance_session_id=s2.id,
            student_user_id=student_shortage.id,
            attendance_status=AttendanceStatus.ABSENT,
            recorded_at=now_utc,
        ),
        AttendanceRecord(
            attendance_session_id=s2.id,
            student_user_id=student_good.id,
            attendance_status=AttendanceStatus.PRESENT,
            recorded_at=now_utc,
        ),
        # s4
        AttendanceRecord(
            attendance_session_id=s4.id,
            student_user_id=student_shortage.id,
            attendance_status=AttendanceStatus.ABSENT,
            recorded_at=now_utc,
        ),
        AttendanceRecord(
            attendance_session_id=s4.id,
            student_user_id=student_good.id,
            attendance_status=AttendanceStatus.PRESENT,
            recorded_at=now_utc,
        ),
        # s6
        AttendanceRecord(
            attendance_session_id=s6.id,
            student_user_id=student_shortage.id,
            attendance_status=AttendanceStatus.ABSENT,
            recorded_at=now_utc,
        ),
        AttendanceRecord(
            attendance_session_id=s6.id,
            student_user_id=student_good.id,
            attendance_status=AttendanceStatus.PRESENT,
            recorded_at=now_utc,
        ),
    ]
    db_session.add_all(records)
    await db_session.flush()

    return {
        "admin": admin,
        "fac_1": fac_1,
        "fac_2": fac_2,
        "fac_unassigned": fac_unassigned,
        "student_shortage": student_shortage,
        "student_good": student_good,
        "term": term,
        "sec_a": sec_a,
        "sec_b": sec_b,
        "sub_cs101": sub_cs101,
        "sub_cs102": sub_cs102,
        "ta_a": ta_a,
        "ta_b": ta_b,
    }


def make_headers(user: User) -> dict:
    token = create_access_token(
        subject=str(user.id),
        role=user.role.value,
        institutional_id=user.institutional_id,
    )
    return {"Authorization": f"Bearer {token}"}


# ===========================================================================
# 1. Overview Scoping Tests: GET /api/v1/analytics/overview
# ===========================================================================


@pytest.mark.asyncio
async def test_analytics_overview_role_scoping(async_client: AsyncClient, analytics_api_env: dict):
    ctx = analytics_api_env

    # 1. Admin overview: institutional scope sees both assignments ta_a and ta_b
    res_admin = await async_client.get("/api/v1/analytics/overview", headers=make_headers(ctx["admin"]))
    assert res_admin.status_code == 200
    data_admin = res_admin.json()
    assert data_admin["role"] == "ADMIN"
    assert data_admin["total_sections"] == 2
    section_ids = [s["teaching_assignment_id"] for s in data_admin["sections"]]
    assert str(ctx["ta_a"].id) in section_ids
    assert str(ctx["ta_b"].id) in section_ids

    # 2. Regular Faculty 1 overview: sees only Section A (ta_a)
    res_fac1 = await async_client.get("/api/v1/analytics/overview", headers=make_headers(ctx["fac_1"]))
    assert res_fac1.status_code == 200
    data_fac1 = res_fac1.json()
    assert data_fac1["role"] == "FACULTY"
    assert data_fac1["total_sections"] == 1
    assert data_fac1["sections"][0]["teaching_assignment_id"] == str(ctx["ta_a"].id)
    assert data_fac1["sections"][0]["is_delegated"] is False

    # 3. Faculty 2 overview: sees Section B (own) and Section A (active substitute delegation)
    res_fac2 = await async_client.get("/api/v1/analytics/overview", headers=make_headers(ctx["fac_2"]))
    assert res_fac2.status_code == 200
    data_fac2 = res_fac2.json()
    assert data_fac2["total_sections"] == 2
    fac2_sections = {s["teaching_assignment_id"]: s["is_delegated"] for s in data_fac2["sections"]}
    assert fac2_sections[str(ctx["ta_a"].id)] is True  # Delegated
    assert fac2_sections[str(ctx["ta_b"].id)] is False  # Own

    # 4. Unassigned Faculty: sees 0 sections
    res_fac3 = await async_client.get("/api/v1/analytics/overview", headers=make_headers(ctx["fac_unassigned"]))
    assert res_fac3.status_code == 200
    data_fac3 = res_fac3.json()
    assert data_fac3["total_sections"] == 0
    assert len(data_fac3["sections"]) == 0

    # 5. Student access to institutional overview is strictly FORBIDDEN -> 403 INSUFFICIENT_ROLE
    res_stu = await async_client.get("/api/v1/analytics/overview", headers=make_headers(ctx["student_shortage"]))
    assert res_stu.status_code == 403
    assert res_stu.json()["error"] == "INSUFFICIENT_ROLE"

    # 6. Student uses GET /api/v1/student/attendance for personal attendance
    res_stu_personal = await async_client.get(
        "/api/v1/student/attendance",
        headers=make_headers(ctx["student_shortage"]),
    )
    assert res_stu_personal.status_code == 200
    data_personal = res_stu_personal.json()
    assert data_personal["student_id"] == str(ctx["student_shortage"].id)
    assert len(data_personal["subjects"]) >= 1


@pytest.mark.asyncio
async def test_analytics_policy_override_protection(async_client: AsyncClient, analytics_api_env: dict):
    ctx = analytics_api_env

    # 1. Faculty cannot change institutional threshold -> 403 INSUFFICIENT_ROLE
    res_fac_override = await async_client.get(
        "/api/v1/analytics/overview?threshold=60.0",
        headers=make_headers(ctx["fac_1"]),
    )
    assert res_fac_override.status_code == 403
    assert res_fac_override.json()["error"] == "INSUFFICIENT_ROLE"

    # 2. Admin CAN change institutional threshold -> 200 OK
    res_adm_override = await async_client.get(
        "/api/v1/analytics/overview?threshold=60.0",
        headers=make_headers(ctx["admin"]),
    )
    assert res_adm_override.status_code == 200
    assert res_adm_override.json()["threshold"] == 60.0

    # 3. Invalid threshold (< 1.0 or > 100.0) -> 422
    res_invalid_low = await async_client.get(
        "/api/v1/analytics/overview?threshold=0.0",
        headers=make_headers(ctx["admin"]),
    )
    assert res_invalid_low.status_code == 422

    res_invalid_high = await async_client.get(
        "/api/v1/analytics/overview?threshold=105.0",
        headers=make_headers(ctx["admin"]),
    )
    assert res_invalid_high.status_code == 422


@pytest.mark.asyncio
async def test_section_analytics_unreachable_threshold_100(async_client: AsyncClient, analytics_api_env: dict):
    ctx = analytics_api_env
    ta_a_id = ctx["ta_a"].id

    # Admin evaluates 100% threshold
    res = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_a_id}?threshold=100.0",
        headers=make_headers(ctx["admin"]),
    )
    assert res.status_code == 200
    data = res.json()
    assert data["threshold"] == 100.0

    # Student Shortage (has missed classes): 100% is mathematically unachievable
    # Must NOT return -1; must return classes_to_recover = null, is_recoverable = False
    stu_shortage_item = next(
        s for s in data["roster_summaries"] if s["student_user_id"] == str(ctx["student_shortage"].id)
    )
    assert stu_shortage_item["classes_to_recover"] is None
    assert stu_shortage_item["is_recoverable"] is False

    # Student Good (100% attendance, 0 missed): classes_to_recover = 0, is_recoverable = True
    stu_good_item = next(
        s for s in data["roster_summaries"] if s["student_user_id"] == str(ctx["student_good"].id)
    )
    assert stu_good_item["classes_to_recover"] == 0
    assert stu_good_item["is_recoverable"] is True


# ===========================================================================
# 2. Detailed Assignment Analytics & Permission Tests
# ===========================================================================


@pytest.mark.asyncio
async def test_section_analytics_authorization_boundaries(async_client: AsyncClient, analytics_api_env: dict):
    ctx = analytics_api_env
    ta_a_id = ctx["ta_a"].id

    # 1. Unauthenticated request -> 401
    res_unauth = await async_client.get(f"/api/v1/analytics/assignments/{ta_a_id}")
    assert res_unauth.status_code == 401

    # 2. Student request -> 403 INSUFFICIENT_ROLE
    res_student = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_a_id}",
        headers=make_headers(ctx["student_shortage"]),
    )
    assert res_student.status_code == 403

    # 3. Unauthorized Faculty (Charles Babbage, no assignments) -> 403 OUT_OF_SCOPE
    res_unassigned = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_a_id}",
        headers=make_headers(ctx["fac_unassigned"]),
    )
    assert res_unassigned.status_code == 403
    assert res_unassigned.json()["error"] == "OUT_OF_SCOPE"

    # 4. Non-existent teaching assignment -> 404 NOT_FOUND
    fake_id = uuid.uuid4()
    res_404 = await async_client.get(
        f"/api/v1/analytics/assignments/{fake_id}",
        headers=make_headers(ctx["fac_1"]),
    )
    assert res_404.status_code in (403, 404)  # Scoping service or entity lookup rejects missing


@pytest.mark.asyncio
async def test_section_analytics_authorized_access_and_substitute(async_client: AsyncClient, analytics_api_env: dict):
    ctx = analytics_api_env
    ta_a_id = ctx["ta_a"].id

    # 1. Regular Faculty accessing Section A -> 200 OK
    res_fac1 = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_a_id}",
        headers=make_headers(ctx["fac_1"]),
    )
    assert res_fac1.status_code == 200
    data_fac1 = res_fac1.json()
    assert data_fac1["teaching_assignment_id"] == str(ta_a_id)
    assert data_fac1["is_delegated"] is False
    assert data_fac1["total_held_sessions"] == 4
    assert data_fac1["total_cancelled_sessions"] == 1
    assert data_fac1["total_exempt_sessions"] == 1

    # 2. Active Substitute Faculty accessing Section A -> 200 OK
    res_fac2 = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_a_id}",
        headers=make_headers(ctx["fac_2"]),
    )
    assert res_fac2.status_code == 200
    data_fac2 = res_fac2.json()
    assert data_fac2["teaching_assignment_id"] == str(ta_a_id)
    assert data_fac2["is_delegated"] is True

    # 3. Admin accessing Section A -> 200 OK
    res_admin = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_a_id}",
        headers=make_headers(ctx["admin"]),
    )
    assert res_admin.status_code == 200


# ===========================================================================
# 3. Shortage Intelligence and Recovery Formula Validation
# ===========================================================================


@pytest.mark.asyncio
async def test_section_analytics_shortage_and_recovery_math(async_client: AsyncClient, analytics_api_env: dict):
    ctx = analytics_api_env
    ta_a_id = ctx["ta_a"].id

    res = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_a_id}?threshold=75.0&consecutive_absent_threshold=2",
        headers=make_headers(ctx["fac_1"]),
    )
    assert res.status_code == 200
    data = res.json()

    # Section metrics:
    # 2 students enrolled, 4 counted sessions held
    # Student Shortage: 1 attended / 4 held = 25.0%
    # Student Good: 4 attended / 4 held = 100.0%
    # Section average: (25.0 + 100.0) / 2 = 62.5%
    assert data["total_enrolled_students"] == 2
    assert data["total_held_sessions"] == 4
    assert data["average_attendance_percentage"] == 62.5
    assert data["shortage_count"] == 1

    # Needing attention list:
    # Only student_shortage should be present
    attention_list = data["students_needing_attention"]
    assert len(attention_list) == 1
    item = attention_list[0]
    assert item["student_user_id"] == str(ctx["student_shortage"].id)
    assert item["attended_sessions"] == 1
    assert item["total_eligible_sessions"] == 4
    assert item["attendance_percentage"] == 25.0
    assert item["is_shortage"] is True

    # Consecutive absences: s6 (ABS), s4 (ABS), s2 (ABS), s1 was PRES -> 3 consecutive absences
    assert item["consecutive_absences"] == 3

    # Recovery classes formula check:
    # R = ceil((75 * 4 - 100 * 1) / (100 - 75)) = ceil((300 - 100) / 25) = ceil(200 / 25) = 8
    assert item["classes_to_recover"] == 8
    assert item["is_recoverable"] is True
    assert item["classes_can_miss"] == 0

    # Roster summaries: verify student_good has recovery = 0 and can_miss > 0
    roster = data["roster_summaries"]
    good_item = next(r for r in roster if r["student_user_id"] == str(ctx["student_good"].id))
    assert good_item["attendance_percentage"] == 100.0
    assert good_item["classes_to_recover"] == 0
    assert good_item["is_recoverable"] is True
    # M = floor(100 * 4 / 75 - 4) = floor(5.333 - 4) = 1
    assert good_item["classes_can_miss"] == 1

    # Weekly trend points populated
    assert len(data["trend"]) >= 1
    point = data["trend"][0]
    assert "period_label" in point
    assert "attendance_percentage" in point
    assert "held_sessions" in point
