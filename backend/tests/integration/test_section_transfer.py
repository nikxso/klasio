from datetime import date, datetime, timezone
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select
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
async def transfer_fixture(db_session: AsyncSession):
    """
    Sets up a full academic context:
    - 1 Admin
    - 2 Faculty: Alpha (Section A) and Beta (Section B)
    - 1 Student: S1
    - 1 Academic Term: Fall 2026
    - 2 Class Sections: CSE-3A and CSE-3B
    - 1 Subject: CS301
    - 2 Teaching Assignments: Alpha -> CSE-3A, Beta -> CSE-3B
    - Initial Enrollment: S1 in CSE-3A from 2026-09-01
    """
    dept = Department(code="CSE-TRF", name="Computer Science Dept")
    term = AcademicTerm(
        code="2026-FALL-TRF",
        name="Fall 2026 Term",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    sec_a = ClassSection(section_code="CSE-3A-TRF", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    sec_b = ClassSection(section_code="CSE-3B-TRF", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    subject = Subject(code="CS301-TRF", name="Data Structures", department_id=dept.id, credits=3)
    db_session.add_all([sec_a, sec_b, subject])
    await db_session.flush()

    admin = User(
        institutional_id="ADM-TRF-01",
        email="admin_trf@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Admin Academic",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_a = User(
        institutional_id="FAC-TRF-A",
        email="faculty_a_trf@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Alpha",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_b = User(
        institutional_id="FAC-TRF-B",
        email="faculty_b_trf@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Beta",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student_1 = User(
        institutional_id="STU-TRF-01",
        email="student_trf@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Student One",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, faculty_a, faculty_b, student_1])
    await db_session.flush()

    ta_a = TeachingAssignment(
        faculty_user_id=faculty_a.id,
        class_section_id=sec_a.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    ta_b = TeachingAssignment(
        faculty_user_id=faculty_b.id,
        class_section_id=sec_b.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add_all([ta_a, ta_b])
    await db_session.flush()

    enr_1 = StudentEnrollment(
        student_user_id=student_1.id,
        class_section_id=sec_a.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 9, 1),
        effective_end_date=None,
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add(enr_1)
    await db_session.flush()

    admin_token = create_access_token(str(admin.id), role="ADMIN", institutional_id=admin.institutional_id)
    faculty_a_token = create_access_token(str(faculty_a.id), role="FACULTY", institutional_id=faculty_a.institutional_id)
    faculty_b_token = create_access_token(str(faculty_b.id), role="FACULTY", institutional_id=faculty_b.institutional_id)
    student_token = create_access_token(str(student_1.id), role="STUDENT", institutional_id=student_1.institutional_id)

    return {
        "admin": admin,
        "faculty_a": faculty_a,
        "faculty_b": faculty_b,
        "student": student_1,
        "sec_a": sec_a,
        "sec_b": sec_b,
        "subject": subject,
        "ta_a": ta_a,
        "ta_b": ta_b,
        "initial_enr": enr_1,
        "admin_token": admin_token,
        "faculty_a_token": faculty_a_token,
        "faculty_b_token": faculty_b_token,
        "student_token": student_token,
    }


@pytest.mark.asyncio
async def test_scenario_a_and_b_basic_section_transfer_and_date_boundary(
    async_client: AsyncClient, db_session: AsyncSession, transfer_fixture
):
    """
    Scenarios A & B: Basic section transfer on transfer_date T (2026-10-20).
    Verifies:
    - Previous enrollment closed with effective_end_date = 2026-10-19 (T-1) and status TRANSFERRED.
    - New enrollment opened with effective_start_date = 2026-10-20 (T) and status ACTIVE.
    """
    fx = transfer_fixture
    t_date = "2026-10-20"

    res = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['admin_token']}"},
        json={
            "student_user_id": str(fx["student"].id),
            "new_class_section_id": str(fx["sec_b"].id),
            "transfer_date": t_date,
        },
    )
    assert res.status_code == 200
    data = res.json()

    assert data["student_user_id"] == str(fx["student"].id)
    assert data["transfer_date"] == t_date

    prev = data["previous_enrollment"]
    assert prev["class_section_id"] == str(fx["sec_a"].id)
    assert prev["effective_start_date"] == "2026-09-01"
    assert prev["effective_end_date"] == "2026-10-19"  # T - 1
    assert prev["enrollment_status"] == "TRANSFERRED"

    new = data["new_enrollment"]
    assert new["class_section_id"] == str(fx["sec_b"].id)
    assert new["effective_start_date"] == "2026-10-20"  # T
    assert new["effective_end_date"] is None
    assert new["enrollment_status"] == "ACTIVE"


@pytest.mark.asyncio
async def test_scenario_c_historical_attendance_preservation(
    async_client: AsyncClient, db_session: AsyncSession, transfer_fixture
):
    """
    Scenario C: Attendance recorded in Section A prior to transfer is immutable.
    Transferring does NOT migrate old attendance, overwrite historical sessions,
    or alter the original academic context.
    """
    fx = transfer_fixture

    # Record historical attendance session in Section A on 2026-10-10
    now_utc = datetime.now(timezone.utc)
    sess_id = uuid.uuid4()
    sess = AttendanceSession(
        id=sess_id,
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=fx["ta_a"].id,
        session_date=date(2026, 10, 10),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        regular_faculty_user_id=fx["faculty_a"].id,
        conducting_faculty_user_id=fx["faculty_a"].id,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_utc,
        records_count=1,
        present_count=1,
        absent_count=0,
        excused_count=0,
    )
    rec = AttendanceRecord(
        id=uuid.uuid4(),
        attendance_session_id=sess_id,
        student_user_id=fx["student"].id,
        attendance_status=AttendanceStatus.PRESENT,
        mark_source=MarkSource.AI_VERIFIED,
        candidate_confidence=0.92,
        recorded_at=now_utc,
    )
    db_session.add_all([sess, rec])
    await db_session.flush()

    # Execute transfer on 2026-10-20
    transfer_res = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['admin_token']}"},
        json={
            "student_user_id": str(fx["student"].id),
            "new_class_section_id": str(fx["sec_b"].id),
            "transfer_date": "2026-10-20",
        },
    )
    assert transfer_res.status_code == 200

    # Query the historical session in PostgreSQL
    persisted_sess = (await db_session.execute(
        select(AttendanceSession).where(AttendanceSession.id == sess_id)
    )).scalar_one()
    assert persisted_sess.teaching_assignment_id == fx["ta_a"].id
    assert persisted_sess.session_date == date(2026, 10, 10)

    persisted_rec = (await db_session.execute(
        select(AttendanceRecord).where(AttendanceRecord.attendance_session_id == sess_id)
    )).scalar_one()
    assert persisted_rec.student_user_id == fx["student"].id
    assert persisted_rec.attendance_status == AttendanceStatus.PRESENT


@pytest.mark.asyncio
async def test_scenario_d_and_e_roster_eligibility_before_and_after_transfer(
    async_client: AsyncClient, db_session: AsyncSession, transfer_fixture
):
    """
    Scenarios D & E: Roster eligibility resolution:
    - Before transfer (2026-10-15 < 2026-10-20):
      Student is eligible in Section A, excluded from Section B.
    - On/After transfer (2026-10-20 and 2026-10-22):
      Student is eligible in Section B, excluded from Section A.
    """
    fx = transfer_fixture

    # Execute transfer on 2026-10-20
    await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['admin_token']}"},
        json={
            "student_user_id": str(fx["student"].id),
            "new_class_section_id": str(fx["sec_b"].id),
            "transfer_date": "2026-10-20",
        },
    )

    # 1. Roster query BEFORE transfer date (2026-10-15):
    # Section A roster must INCLUDE student S1
    roster_a_pre = await async_client.get(
        f"/api/v1/faculty/assignments/{fx['ta_a'].id}/roster?session_date=2026-10-15",
        headers={"Authorization": f"Bearer {fx['faculty_a_token']}"},
    )
    assert roster_a_pre.status_code == 200
    stu_ids_a_pre = [s["student_user_id"] for s in roster_a_pre.json()["eligible_students"]]
    assert str(fx["student"].id) in stu_ids_a_pre

    # Section B roster must EXCLUDE student S1
    roster_b_pre = await async_client.get(
        f"/api/v1/faculty/assignments/{fx['ta_b'].id}/roster?session_date=2026-10-15",
        headers={"Authorization": f"Bearer {fx['faculty_b_token']}"},
    )
    assert roster_b_pre.status_code == 200
    stu_ids_b_pre = [s["student_user_id"] for s in roster_b_pre.json()["eligible_students"]]
    assert str(fx["student"].id) not in stu_ids_b_pre

    # 2. Roster query ON transfer date (2026-10-20):
    # Section A must EXCLUDE student S1
    roster_a_on = await async_client.get(
        f"/api/v1/faculty/assignments/{fx['ta_a'].id}/roster?session_date=2026-10-20",
        headers={"Authorization": f"Bearer {fx['faculty_a_token']}"},
    )
    assert roster_a_on.status_code == 200
    stu_ids_a_on = [s["student_user_id"] for s in roster_a_on.json()["eligible_students"]]
    assert str(fx["student"].id) not in stu_ids_a_on

    # Section B must INCLUDE student S1
    roster_b_on = await async_client.get(
        f"/api/v1/faculty/assignments/{fx['ta_b'].id}/roster?session_date=2026-10-20",
        headers={"Authorization": f"Bearer {fx['faculty_b_token']}"},
    )
    assert roster_b_on.status_code == 200
    stu_ids_b_on = [s["student_user_id"] for s in roster_b_on.json()["eligible_students"]]
    assert str(fx["student"].id) in stu_ids_b_on

    # 3. Roster query AFTER transfer date (2026-10-25):
    # Section A must EXCLUDE student S1
    roster_a_post = await async_client.get(
        f"/api/v1/faculty/assignments/{fx['ta_a'].id}/roster?session_date=2026-10-25",
        headers={"Authorization": f"Bearer {fx['faculty_a_token']}"},
    )
    assert roster_a_post.status_code == 200
    stu_ids_a_post = [s["student_user_id"] for s in roster_a_post.json()["eligible_students"]]
    assert str(fx["student"].id) not in stu_ids_a_post

    # Section B must INCLUDE student S1
    roster_b_post = await async_client.get(
        f"/api/v1/faculty/assignments/{fx['ta_b'].id}/roster?session_date=2026-10-25",
        headers={"Authorization": f"Bearer {fx['faculty_b_token']}"},
    )
    assert roster_b_post.status_code == 200
    stu_ids_b_post = [s["student_user_id"] for s in roster_b_post.json()["eligible_students"]]
    assert str(fx["student"].id) in stu_ids_b_post


@pytest.mark.asyncio
async def test_scenario_f_overlap_rejection(
    async_client: AsyncClient, db_session: AsyncSession, transfer_fixture
):
    """
    Scenario F: Overlap rejection:
    Attempting to directly enroll a student into an overlapping interval is rejected.
    """
    fx = transfer_fixture

    res = await async_client.post(
        "/api/v1/admin/enrollments",
        headers={"Authorization": f"Bearer {fx['admin_token']}"},
        json={
            "student_user_id": str(fx["student"].id),
            "class_section_id": str(fx["sec_b"].id),
            "academic_term_id": str(fx["sec_b"].academic_term_id),
            "effective_start_date": "2026-09-15",
            "effective_end_date": None,
            "enrollment_status": "ACTIVE",
        },
    )
    assert res.status_code == 400
    assert res.json()["error"] == "STUDENT_INELIGIBLE"


@pytest.mark.asyncio
async def test_scenario_g_duplicate_transition_handling(
    async_client: AsyncClient, db_session: AsyncSession, transfer_fixture
):
    """
    Scenario G: Duplicate transition handling:
    Transferring a student who has already been transferred on that date
    (or no longer has an active enrollment covering that date) is rejected.
    """
    fx = transfer_fixture

    # First transfer succeeds
    res1 = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['admin_token']}"},
        json={
            "student_user_id": str(fx["student"].id),
            "new_class_section_id": str(fx["sec_b"].id),
            "transfer_date": "2026-10-20",
        },
    )
    assert res1.status_code == 200

    # Second transfer on same date to Section B (student is already in Section B)
    res2 = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['admin_token']}"},
        json={
            "student_user_id": str(fx["student"].id),
            "new_class_section_id": str(fx["sec_b"].id),
            "transfer_date": "2026-10-20",
        },
    )
    assert res2.status_code == 400
    assert "already enrolled" in res2.json()["message"]


@pytest.mark.asyncio
async def test_scenario_h_same_section_transfer_handling(
    async_client: AsyncClient, db_session: AsyncSession, transfer_fixture
):
    """
    Scenario H: Transferring a student to the same section they currently belong to is rejected.
    """
    fx = transfer_fixture

    res = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['admin_token']}"},
        json={
            "student_user_id": str(fx["student"].id),
            "new_class_section_id": str(fx["sec_a"].id),  # Same as initial
            "transfer_date": "2026-10-20",
        },
    )
    assert res.status_code == 400
    assert "already enrolled" in res.json()["message"]


@pytest.mark.asyncio
async def test_scenario_i_authorization(
    async_client: AsyncClient, transfer_fixture
):
    """
    Scenario I: Authorization enforcement:
    - Faculty cannot transfer student (403 Forbidden).
    - Student cannot transfer student (403 Forbidden).
    - Unauthenticated cannot transfer student (401 Unauthorized).
    """
    fx = transfer_fixture
    body = {
        "student_user_id": str(fx["student"].id),
        "new_class_section_id": str(fx["sec_b"].id),
        "transfer_date": "2026-10-20",
    }

    # Faculty caller
    res_fac = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['faculty_a_token']}"},
        json=body,
    )
    assert res_fac.status_code == 403

    # Student caller
    res_stu = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['student_token']}"},
        json=body,
    )
    assert res_stu.status_code == 403

    # Unauthenticated caller
    res_anon = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        json=body,
    )
    assert res_anon.status_code == 401


@pytest.mark.asyncio
async def test_scenario_j_transaction_rollback_on_failure(
    async_client: AsyncClient, db_session: AsyncSession, transfer_fixture
):
    """
    Scenario J: Transaction rollback on failure:
    If validation fails (e.g. non-existent target section), no partial
    mutation of the current enrollment occurs.
    """
    fx = transfer_fixture
    fake_section_id = str(uuid.uuid4())

    res = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['admin_token']}"},
        json={
            "student_user_id": str(fx["student"].id),
            "new_class_section_id": fake_section_id,
            "transfer_date": "2026-10-20",
        },
    )
    assert res.status_code == 404

    # Verify original enrollment in Section A is completely unchanged
    enr = (await db_session.execute(
        select(StudentEnrollment).where(StudentEnrollment.student_user_id == fx["student"].id)
    )).scalar_one()
    assert enr.class_section_id == fx["sec_a"].id
    assert enr.effective_end_date is None
    assert enr.enrollment_status == EnrollmentStatus.ACTIVE


@pytest.mark.asyncio
async def test_scenario_k_historical_attendance_percentage_invariance(
    async_client: AsyncClient, db_session: AsyncSession, transfer_fixture
):
    """
    Scenario K: Historical attendance percentage invariant:
    Sessions in Section A before transfer remain part of Section A historical summary.
    Transferring does not retroactively alter the percentage or denominator for Section A.
    """
    fx = transfer_fixture

    # Conduct 2 sessions in Section A: Sept 10 and Sept 15
    # Student S1 attends Sept 10 (PRESENT) and misses Sept 15 (ABSENT) -> 1/2 = 50.0%
    now_utc = datetime.now(timezone.utc)
    for d, status_val in [(date(2026, 9, 10), AttendanceStatus.PRESENT), (date(2026, 9, 15), AttendanceStatus.ABSENT)]:
        sess_id = uuid.uuid4()
        s = AttendanceSession(
            id=sess_id,
            client_session_uuid=uuid.uuid4(),
            teaching_assignment_id=fx["ta_a"].id,
            session_date=d,
            period_slot_or_sequence=1,
            applicability_status=SessionApplicability.COUNTED,
            regular_faculty_user_id=fx["faculty_a"].id,
            conducting_faculty_user_id=fx["faculty_a"].id,
            session_status=AttendanceSessionStatus.FINALIZED,
            finalized_at=now_utc,
            records_count=1,
            present_count=1 if status_val == AttendanceStatus.PRESENT else 0,
            absent_count=1 if status_val == AttendanceStatus.ABSENT else 0,
            excused_count=0,
        )
        r = AttendanceRecord(
            id=uuid.uuid4(),
            attendance_session_id=sess_id,
            student_user_id=fx["student"].id,
            attendance_status=status_val,
            mark_source=MarkSource.MANUAL_MARK,
            recorded_at=now_utc,
        )
        db_session.add_all([s, r])
    await db_session.flush()

    # Student portal before transfer:
    # 1 attended out of 2 eligible = 50.0%
    res_pre = await async_client.get(
        "/api/v1/student/attendance",
        headers={"Authorization": f"Bearer {fx['student_token']}"},
    )
    assert res_pre.status_code == 200
    data_pre = res_pre.json()
    assert data_pre["overall_attendance_percentage"] == 50.0
    assert data_pre["subjects"][0]["total_eligible_sessions"] == 2
    assert data_pre["subjects"][0]["attended_sessions"] == 1

    # Execute transfer to Section B effective 2026-10-20
    transfer_res = await async_client.post(
        "/api/v1/admin/enrollments/transfer",
        headers={"Authorization": f"Bearer {fx['admin_token']}"},
        json={
            "student_user_id": str(fx["student"].id),
            "new_class_section_id": str(fx["sec_b"].id),
            "transfer_date": "2026-10-20",
        },
    )
    assert transfer_res.status_code == 200

    # Conduct a session in Section A on 2026-10-25 (after transfer)
    # Student S1 is no longer in Section A, so this session MUST NOT enter S1's denominator!
    sess_a_post_id = uuid.uuid4()
    sess_a_post = AttendanceSession(
        id=sess_a_post_id,
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=fx["ta_a"].id,
        session_date=date(2026, 10, 25),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        regular_faculty_user_id=fx["faculty_a"].id,
        conducting_faculty_user_id=fx["faculty_a"].id,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_utc,
        records_count=0,
        present_count=0,
        absent_count=0,
        excused_count=0,
    )
    db_session.add(sess_a_post)
    await db_session.flush()

    # Conduct a session in Section B on 2026-10-25 (after transfer)
    # Student S1 attends in Section B -> PRESENT!
    sess_b_post_id = uuid.uuid4()
    sess_b_post = AttendanceSession(
        id=sess_b_post_id,
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=fx["ta_b"].id,
        session_date=date(2026, 10, 25),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        regular_faculty_user_id=fx["faculty_b"].id,
        conducting_faculty_user_id=fx["faculty_b"].id,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_utc,
        records_count=1,
        present_count=1,
        absent_count=0,
        excused_count=0,
    )
    rec_b_post = AttendanceRecord(
        id=uuid.uuid4(),
        attendance_session_id=sess_b_post_id,
        student_user_id=fx["student"].id,
        attendance_status=AttendanceStatus.PRESENT,
        mark_source=MarkSource.AI_VERIFIED,
        candidate_confidence=0.94,
        recorded_at=now_utc,
    )
    db_session.add_all([sess_b_post, rec_b_post])
    await db_session.flush()

    # Student portal query post-transfer:
    # Section A summary: still 1 / 2 = 50.0% (session on Oct 25 was excluded from Section A denominator!)
    # Section B summary: 1 / 1 = 100.0%
    # Overall: (1 + 1) / (2 + 1) = 2/3 = 66.7%
    res_post = await async_client.get(
        "/api/v1/student/attendance",
        headers={"Authorization": f"Bearer {fx['student_token']}"},
    )
    assert res_post.status_code == 200
    data_post = res_post.json()

    # Find Section A and Section B subject summaries
    summaries = data_post["subjects"]
    assert len(summaries) == 2

    sec_a_summary = next(s for s in summaries if s["faculty_name"] == "Prof Alpha")
    sec_b_summary = next(s for s in summaries if s["faculty_name"] == "Prof Beta")

    # Section A historical record is 100% stable
    assert sec_a_summary["total_eligible_sessions"] == 2
    assert sec_a_summary["attended_sessions"] == 1
    assert sec_a_summary["attendance_percentage"] == 50.0

    # Section B starts accumulating from transfer date
    assert sec_b_summary["total_eligible_sessions"] == 1
    assert sec_b_summary["attended_sessions"] == 1
    assert sec_b_summary["attendance_percentage"] == 100.0

    assert data_post["overall_attendance_percentage"] == 66.7
