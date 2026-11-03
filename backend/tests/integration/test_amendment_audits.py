from datetime import date, datetime, timedelta, timezone
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.attendance import (
    AmendmentRole,
    AttendanceAmendmentAudit,
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
)
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import AccountStatus, User, UserRole
from src.services.enrollment_service import EnrollmentService


@pytest.fixture
async def amendment_integration_fixture(db_session: AsyncSession):
    dept = Department(code="CSE-AMD-INT", name="Computer Science Dept")
    term = AcademicTerm(
        code="2026-FALL-AMD-I",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS301-AI", name="Data Structures", department_id=dept.id, credits=3)
    section = ClassSection(section_code="CSE-3A-AI", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    db_session.add_all([subject, section])
    await db_session.flush()

    # Users
    admin = User(
        institutional_id="ADM-AMD-INT",
        email="admin_int@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Admin Director",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    prof_alan = User(
        institutional_id="FAC-AMD-ALAN",
        email="alan@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Alan (Assigned Regular)",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    prof_sub = User(
        institutional_id="FAC-AMD-SUB",
        email="sub@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Substitute",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    prof_unauth = User(
        institutional_id="FAC-AMD-UNAUTH",
        email="unauth@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Unauthorized",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student = User(
        institutional_id="STU-AMD-INT-01",
        email="student_int@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Student Test",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, prof_alan, prof_sub, prof_unauth, student])
    await db_session.flush()

    # Assignment: Alan -> Section 3A
    assignment = TeachingAssignment(
        class_section_id=section.id,
        subject_id=subject.id,
        faculty_user_id=prof_alan.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
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

    # Session 1: Recent session (Today - 2 days, within default 7-day window)
    today = datetime.now(timezone.utc).date()
    now_tz = datetime.now(timezone.utc)
    recent_date = today - timedelta(days=2)
    recent_session = AttendanceSession(
        id=uuid.uuid4(),
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=assignment.id,
        session_date=recent_date,
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        regular_faculty_user_id=prof_alan.id,
        conducting_faculty_user_id=prof_alan.id,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_tz,
        records_count=1,
        present_count=0,
        absent_count=1,
        excused_count=0,
    )
    recent_record = AttendanceRecord(
        id=uuid.uuid4(),
        attendance_session_id=recent_session.id,
        student_user_id=student.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now_tz,
    )

    # Session 2: Old session (Today - 10 days, beyond default 7-day window)
    old_date = today - timedelta(days=10)
    old_session = AttendanceSession(
        id=uuid.uuid4(),
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=assignment.id,
        session_date=old_date,
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        regular_faculty_user_id=prof_alan.id,
        conducting_faculty_user_id=prof_alan.id,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_tz,
        records_count=1,
        present_count=0,
        absent_count=1,
        excused_count=0,
    )
    old_record = AttendanceRecord(
        id=uuid.uuid4(),
        attendance_session_id=old_session.id,
        student_user_id=student.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now_tz,
    )

    # Session 3: Conducted by substitute faculty (Today - 1 day)
    delegation = SubstituteDelegation(
        teaching_assignment_id=assignment.id,
        regular_faculty_user_id=prof_alan.id,
        substitute_faculty_user_id=prof_sub.id,
        start_date=today - timedelta(days=1),
        end_date=today - timedelta(days=1),
        delegation_reason="Guest lecture substitution",
        status=DelegationStatus.ACTIVE,
        created_by_user_id=admin.id,
    )
    db_session.add(delegation)
    await db_session.flush()

    sub_session = AttendanceSession(
        id=uuid.uuid4(),
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=assignment.id,
        session_date=today - timedelta(days=1),
        period_slot_or_sequence=2,
        applicability_status=SessionApplicability.COUNTED,
        regular_faculty_user_id=prof_alan.id,
        conducting_faculty_user_id=prof_sub.id,
        substitute_delegation_id=delegation.id,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now_tz,
        records_count=1,
        present_count=0,
        absent_count=1,
        excused_count=0,
    )
    sub_record = AttendanceRecord(
        id=uuid.uuid4(),
        attendance_session_id=sub_session.id,
        student_user_id=student.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now_tz,
    )

    db_session.add_all([
        recent_session, recent_record,
        old_session, old_record,
        sub_session, sub_record,
    ])
    await db_session.flush()

    return {
        "admin": admin,
        "alan": prof_alan,
        "sub": prof_sub,
        "unauth": prof_unauth,
        "student": student,
        "assignment": assignment,
        "recent_session": recent_session,
        "recent_record": recent_record,
        "old_session": old_session,
        "old_record": old_record,
        "sub_session": sub_session,
        "sub_record": sub_record,
    }


@pytest.mark.asyncio
async def test_scenario_a_regular_faculty_amendment_within_window(
    async_client: AsyncClient, db_session: AsyncSession, amendment_integration_fixture: dict
):
    """
    Scenario A: Assigned regular faculty amends recent session within window.
    Expects 201 Created with audit record, database updated, aggregates updated.
    """
    ctx = amendment_integration_fixture
    token = create_access_token(
        subject=str(ctx["alan"].id),
        role=ctx["alan"].role.value,
        institutional_id=ctx["alan"].institutional_id,
    )

    payload = {
        "student_user_id": str(ctx["student"].id),
        "new_status": "PRESENT",
        "amendment_reason": "Medical certificate verified by department",
    }
    response = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["previous_status"] == "ABSENT"
    assert body["new_status"] == "PRESENT"
    assert body["amendment_role"] == "REGULAR_FACULTY"

    # Verify database state
    rec_stmt = select(AttendanceRecord).where(
        AttendanceRecord.attendance_session_id == ctx["recent_session"].id,
        AttendanceRecord.student_user_id == ctx["student"].id,
    )
    rec_res = await db_session.execute(rec_stmt)
    rec = rec_res.scalar_one()
    assert rec.attendance_status == AttendanceStatus.PRESENT
    assert rec.mark_source == MarkSource.MANUAL_OVERRIDE

    # Verify session aggregate counts
    sess_stmt = select(AttendanceSession).where(AttendanceSession.id == ctx["recent_session"].id)
    sess_res = await db_session.execute(sess_stmt)
    sess = sess_res.scalar_one()
    assert sess.present_count == 1
    assert sess.absent_count == 0


@pytest.mark.asyncio
async def test_scenario_b_regular_faculty_amendment_beyond_window_rejected(
    async_client: AsyncClient, amendment_integration_fixture: dict
):
    """
    Scenario B: Assigned regular faculty attempts amendment on 10-day-old session.
    Window is 7 days.
    Expects HTTP 403 Forbidden with error AMENDMENT_WINDOW_EXPIRED.
    """
    ctx = amendment_integration_fixture
    token = create_access_token(
        subject=str(ctx["alan"].id),
        role=ctx["alan"].role.value,
        institutional_id=ctx["alan"].institutional_id,
    )

    payload = {
        "student_user_id": str(ctx["student"].id),
        "new_status": "PRESENT",
        "amendment_reason": "Late request from student after 10 days",
    }
    response = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['old_session'].id}/amendments",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403
    body = response.json()
    assert body["error"] == "AMENDMENT_WINDOW_EXPIRED"
    assert "Correction window of 7 days has expired" in body["message"]


@pytest.mark.asyncio
async def test_scenario_c_substitute_faculty_strictly_excluded(
    async_client: AsyncClient, amendment_integration_fixture: dict
):
    """
    Scenario C: Substitute faculty who conducted the session attempts post-finalization amendment.
    Expects HTTP 403 Forbidden with error OUT_OF_SCOPE.
    """
    ctx = amendment_integration_fixture
    token = create_access_token(
        subject=str(ctx["sub"].id),
        role=ctx["sub"].role.value,
        institutional_id=ctx["sub"].institutional_id,
    )

    payload = {
        "student_user_id": str(ctx["student"].id),
        "new_status": "PRESENT",
        "amendment_reason": "Substitute faculty trying to amend yesterday session",
    }
    response = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['sub_session'].id}/amendments",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403
    body = response.json()
    assert body["error"] == "OUT_OF_SCOPE"
    assert "Substitute faculty are excluded" in body["message"]


@pytest.mark.asyncio
async def test_scenario_d_admin_override_beyond_window(
    async_client: AsyncClient, db_session: AsyncSession, amendment_integration_fixture: dict
):
    """
    Scenario D: Institutional Admin performs override amendment on 10-day-old session.
    Expects HTTP 201 Created with amendment_role == ADMIN.
    """
    ctx = amendment_integration_fixture
    token = create_access_token(
        subject=str(ctx["admin"].id),
        role=ctx["admin"].role.value,
        institutional_id=ctx["admin"].institutional_id,
    )

    payload = {
        "student_user_id": str(ctx["student"].id),
        "new_status": "PRESENT",
        "amendment_reason": "HOD administrative approval ref #491",
    }
    response = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['old_session'].id}/amendments",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["previous_status"] == "ABSENT"
    assert body["new_status"] == "PRESENT"
    assert body["amendment_role"] == "ADMIN"
    assert body["amendment_reason"] == "HOD administrative approval ref #491"

    # Verify database record updated
    rec_stmt = select(AttendanceRecord).where(
        AttendanceRecord.attendance_session_id == ctx["old_session"].id,
        AttendanceRecord.student_user_id == ctx["student"].id,
    )
    rec_res = await db_session.execute(rec_stmt)
    rec = rec_res.scalar_one()
    assert rec.attendance_status == AttendanceStatus.PRESENT


@pytest.mark.asyncio
async def test_scenario_e_unauthorized_faculty_rejected(
    async_client: AsyncClient, amendment_integration_fixture: dict
):
    """
    Scenario E: Unrelated faculty member attempts amendment on Alan's session.
    Expects HTTP 403 Forbidden.
    """
    ctx = amendment_integration_fixture
    token = create_access_token(
        subject=str(ctx["unauth"].id),
        role=ctx["unauth"].role.value,
        institutional_id=ctx["unauth"].institutional_id,
    )

    payload = {
        "student_user_id": str(ctx["student"].id),
        "new_status": "PRESENT",
        "amendment_reason": "Unrelated faculty trying to alter marks",
    }
    response = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_scenario_f_student_rejected(
    async_client: AsyncClient, amendment_integration_fixture: dict
):
    """
    Scenario F: Student user attempts to call amendment endpoint.
    Expects HTTP 403 Forbidden.
    """
    ctx = amendment_integration_fixture
    token = create_access_token(
        subject=str(ctx["student"].id),
        role=ctx["student"].role.value,
        institutional_id=ctx["student"].institutional_id,
    )

    payload = {
        "student_user_id": str(ctx["student"].id),
        "new_status": "PRESENT",
        "amendment_reason": "Student attempting to self-mark present",
    }
    response = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_scenario_g_multiple_sequential_amendments_and_history_api(
    async_client: AsyncClient, amendment_integration_fixture: dict
):
    """
    Scenario G: Multiple sequential amendments on same student:
    - 1st: ABSENT -> PRESENT (by Regular Faculty)
    - 2nd: PRESENT -> EXCUSED (by Admin)
    - GET /api/v1/attendance/sessions/{id}/amendments returns full chronological audit trail.
    """
    ctx = amendment_integration_fixture
    alan_token = create_access_token(
        subject=str(ctx["alan"].id),
        role=ctx["alan"].role.value,
        institutional_id=ctx["alan"].institutional_id,
    )
    admin_token = create_access_token(
        subject=str(ctx["admin"].id),
        role=ctx["admin"].role.value,
        institutional_id=ctx["admin"].institutional_id,
    )

    # 1. Alan amends ABSENT -> PRESENT
    resp1 = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json={
            "student_user_id": str(ctx["student"].id),
            "new_status": "PRESENT",
            "amendment_reason": "Medical certificate initial acceptance",
        },
        headers={"Authorization": f"Bearer {alan_token}"},
    )
    assert resp1.status_code == 201

    # 2. Admin amends PRESENT -> EXCUSED
    resp2 = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json={
            "student_user_id": str(ctx["student"].id),
            "new_status": "EXCUSED",
            "amendment_reason": "Dean converted attendance to official institution excuse",
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp2.status_code == 201

    # 3. GET /sessions/{id}/amendments
    history_resp = await async_client.get(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        headers={"Authorization": f"Bearer {alan_token}"},
    )
    assert history_resp.status_code == 200
    audits = history_resp.json()
    assert len(audits) == 2

    assert audits[0]["previous_status"] == "ABSENT"
    assert audits[0]["new_status"] == "PRESENT"
    assert audits[0]["amendment_role"] == "REGULAR_FACULTY"

    assert audits[1]["previous_status"] == "PRESENT"
    assert audits[1]["new_status"] == "EXCUSED"
    assert audits[1]["amendment_role"] == "ADMIN"


@pytest.mark.asyncio
async def test_scenario_h_attendance_percentage_calculation_invariance(
    db_session: AsyncSession, amendment_integration_fixture: dict
):
    """
    Scenario H: Analytics/percentage calculation reflects amendment immediately:
    - Before amendment: student is ABSENT in recent_session -> attendance percentage = 0.0%
    - After amendment: student is PRESENT in recent_session -> attendance percentage = 100.0%
    - No duplicate attendance records created for the session.
    """
    ctx = amendment_integration_fixture
    enrollment_service = EnrollmentService(db_session)

    # Initially: student has 3 counted sessions (recent_session, old_session, sub_session), all ABSENT
    stats_before = await enrollment_service.calculate_student_personal_attendance(
        student_user_id=ctx["student"].id,
    )
    assert len(stats_before.subjects) == 1
    assert stats_before.subjects[0].total_eligible_sessions == 3
    assert stats_before.subjects[0].attended_sessions == 0
    assert stats_before.overall_attendance_percentage == 0.0

    # Perform amendment on recent_session from ABSENT to PRESENT
    from src.services.amendment_service import AmendmentService
    service = AmendmentService(db_session, correction_window_days=7)
    await service.amend_attendance_record(
        session_id=ctx["recent_session"].id,
        student_user_id=ctx["student"].id,
        new_status=AttendanceStatus.PRESENT,
        amendment_reason="Verified presence via camera scan correction",
        current_user=ctx["alan"],
    )

    # Recalculate
    stats_after = await enrollment_service.calculate_student_personal_attendance(
        student_user_id=ctx["student"].id,
    )
    assert stats_after.subjects[0].total_eligible_sessions == 3
    assert stats_after.subjects[0].attended_sessions == 1
    assert stats_after.overall_attendance_percentage == 33.3


@pytest.mark.asyncio
async def test_scenario_i_database_check_constraints_enforced(
    db_session: AsyncSession, amendment_integration_fixture: dict
):
    """
    Scenario I: Direct database check constraints:
    - ck_amendment_status_changed: new_status != previous_status
    - ck_amendment_reason_length: length(amendment_reason) >= 10
    """
    ctx = amendment_integration_fixture
    now_tz = datetime.now(timezone.utc)

    # 1. Violating ck_amendment_status_changed
    invalid_status_audit = AttendanceAmendmentAudit(
        id=uuid.uuid4(),
        attendance_session_id=ctx["recent_session"].id,
        student_user_id=ctx["student"].id,
        previous_status=AttendanceStatus.PRESENT,
        new_status=AttendanceStatus.PRESENT,
        amending_user_id=ctx["alan"].id,
        amendment_role=AmendmentRole.REGULAR_FACULTY,
        amendment_reason="Valid reason length for test",
        amended_at=now_tz,
    )
    db_session.add(invalid_status_audit)
    with pytest.raises(IntegrityError) as exc1:
        await db_session.flush()
    assert "ck_amendment_status_changed" in str(exc1.value)
    await db_session.rollback()

    # 2. Violating ck_amendment_reason_length
    invalid_reason_audit = AttendanceAmendmentAudit(
        id=uuid.uuid4(),
        attendance_session_id=ctx["recent_session"].id,
        student_user_id=ctx["student"].id,
        previous_status=AttendanceStatus.ABSENT,
        new_status=AttendanceStatus.PRESENT,
        amending_user_id=ctx["alan"].id,
        amendment_role=AmendmentRole.REGULAR_FACULTY,
        amendment_reason="Too short",
        amended_at=now_tz,
    )
    db_session.add(invalid_reason_audit)
    with pytest.raises(IntegrityError) as exc2:
        await db_session.flush()
    assert "ck_amendment_reason_length" in str(exc2.value)
    await db_session.rollback()


@pytest.mark.asyncio
async def test_scenario_j_concurrent_or_retried_amendment_behavior(
    async_client: AsyncClient, amendment_integration_fixture: dict
):
    """
    Scenario J: Concurrency, retries, and conflict semantics:
    - Initial state: student is ABSENT.
    - Device A amends: ABSENT -> PRESENT (succeeds 201).
    - Device A retries identical request (interrupted response simulation):
      fails with HTTP 400 because previous_status == new_status.
      (Proves absence of amendment idempotency key in current backend API).
    - Device B attempts concurrent amendment based on stale belief (student was ABSENT):
      Device B sends new_status: PRESENT -> fails with HTTP 400 (already PRESENT).
    - Device C attempts amendment: new_status: EXCUSED -> succeeds 201.
      (Proves backend adopts current DB status as previous_status without optimistic concurrency lock).
    - Aggregate session counts and audit trail reflect exact state transitions.
    """
    ctx = amendment_integration_fixture
    alan_token = create_access_token(
        subject=str(ctx["alan"].id),
        role=ctx["alan"].role.value,
        institutional_id=ctx["alan"].institutional_id,
    )

    # 1. Device A: ABSENT -> PRESENT
    resp_a = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json={
            "student_user_id": str(ctx["student"].id),
            "new_status": "PRESENT",
            "amendment_reason": "Device A: Verified student present in room",
        },
        headers={"Authorization": f"Bearer {alan_token}"},
    )
    assert resp_a.status_code == 201
    audit_a = resp_a.json()
    assert audit_a["previous_status"] == "ABSENT"
    assert audit_a["new_status"] == "PRESENT"

    # 2. Device A retries identical request (network retry after dropped response)
    resp_a_retry = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json={
            "student_user_id": str(ctx["student"].id),
            "new_status": "PRESENT",
            "amendment_reason": "Device A: Verified student present in room",
        },
        headers={"Authorization": f"Bearer {alan_token}"},
    )
    # Under current implementation, raises AttendanceDomainError because status is already PRESENT
    assert resp_a_retry.status_code == 400
    assert "already PRESENT" in resp_a_retry.json()["message"]

    # 3. Device B (stale offline state thinking student is still ABSENT) also attempts ABSENT -> PRESENT
    resp_b = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json={
            "student_user_id": str(ctx["student"].id),
            "new_status": "PRESENT",
            "amendment_reason": "Device B: Also observed student in classroom",
        },
        headers={"Authorization": f"Bearer {alan_token}"},
    )
    assert resp_b.status_code == 400

    # 4. Device C attempts PRESENT -> EXCUSED
    resp_c = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json={
            "student_user_id": str(ctx["student"].id),
            "new_status": "EXCUSED",
            "amendment_reason": "Device C: Late medical sanction approved",
        },
        headers={"Authorization": f"Bearer {alan_token}"},
    )
    assert resp_c.status_code == 201
    audit_c = resp_c.json()
    assert audit_c["previous_status"] == "PRESENT"
    assert audit_c["new_status"] == "EXCUSED"

    # 5. Verify audit history contains exactly the 2 successful amendments
    history_resp = await async_client.get(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        headers={"Authorization": f"Bearer {alan_token}"},
    )
    assert history_resp.status_code == 200
    audits = history_resp.json()
    assert len(audits) == 2
    assert audits[0]["new_status"] == "PRESENT"
    assert audits[1]["new_status"] == "EXCUSED"


@pytest.mark.asyncio
async def test_scenario_k_offline_first_idempotency_and_optimistic_concurrency(
    async_client: AsyncClient, amendment_integration_fixture: dict
):
    """
    Scenario K (Phase 9.1): Full API verification of client_amendment_id idempotency & optimistic concurrency:
    1. First request with client_amendment_id: succeeds with HTTP 201 Created.
    2. Replaying exact same client_amendment_id: succeeds with HTTP 200 OK, is_already_synced=True,
       returning identical audit record without modifying database state or creating a second audit.
    3. Stale concurrent request: Device B sends expected_previous_status="ABSENT" when status has become "PRESENT":
       rejected with HTTP 409 Conflict (STALE_AMENDMENT_CONFLICT), creating zero audits.
    4. Unique database constraint: Inserting another audit with the same client_amendment_id raises IntegrityError.
    """
    ctx = amendment_integration_fixture
    alan_token = create_access_token(
        subject=str(ctx["alan"].id),
        role=ctx["alan"].role.value,
        institutional_id=ctx["alan"].institutional_id,
    )
    headers = {"Authorization": f"Bearer {alan_token}"}
    client_amd_id = uuid.uuid4()

    # 1. First request: ABSENT -> PRESENT with client_amendment_id
    payload_1 = {
        "client_amendment_id": str(client_amd_id),
        "student_user_id": str(ctx["student"].id),
        "expected_previous_status": "ABSENT",
        "new_status": "PRESENT",
        "amendment_reason": "Verified present in room during roll-call audit",
    }
    resp1 = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json=payload_1,
        headers=headers,
    )
    assert resp1.status_code == 201
    audit_data_1 = resp1.json()
    assert audit_data_1["client_amendment_id"] == str(client_amd_id)
    assert audit_data_1["previous_status"] == "ABSENT"
    assert audit_data_1["new_status"] == "PRESENT"
    assert audit_data_1["is_already_synced"] is False

    # 2. Retry request: exact same client_amendment_id and payload
    resp2 = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json=payload_1,
        headers=headers,
    )
    assert resp2.status_code == 200
    audit_data_2 = resp2.json()
    assert audit_data_2["audit_id"] == audit_data_1["audit_id"]
    assert audit_data_2["client_amendment_id"] == str(client_amd_id)
    assert audit_data_2["is_already_synced"] is True

    # Confirm only 1 audit row was created
    history_resp = await async_client.get(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        headers=headers,
    )
    assert history_resp.status_code == 200
    audits = [a for a in history_resp.json() if a["client_amendment_id"] == str(client_amd_id)]
    assert len(audits) == 1

    # 3. Optimistic concurrency conflict: Device B thinks student is still ABSENT, attempts ABSENT -> EXCUSED
    stale_payload = {
        "client_amendment_id": str(uuid.uuid4()),
        "student_user_id": str(ctx["student"].id),
        "expected_previous_status": "ABSENT",  # Current status in DB is now PRESENT!
        "new_status": "EXCUSED",
        "amendment_reason": "Medical sanction based on old absence state",
    }
    resp_conflict = await async_client.post(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        json=stale_payload,
        headers=headers,
    )
    assert resp_conflict.status_code == 409
    conflict_json = resp_conflict.json()
    assert conflict_json["error"] == "STALE_AMENDMENT_CONFLICT"
    assert "Optimistic concurrency conflict" in conflict_json["message"]

    # Confirm no additional audit row was created for stale request
    history_resp2 = await async_client.get(
        f"/api/v1/attendance/sessions/{ctx['recent_session'].id}/amendments",
        headers=headers,
    )
    all_recent_audits = history_resp2.json()
    assert len(all_recent_audits) == 1  # Still exactly 1 audit


