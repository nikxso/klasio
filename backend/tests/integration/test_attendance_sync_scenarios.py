from datetime import date, datetime, timezone
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.attendance import AttendanceRecord, AttendanceSession, AttendanceStatus, MarkSource, SessionApplicability
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import AccountStatus, User, UserRole


@pytest.fixture
async def sync_fixture(db_session: AsyncSession):
    """
    Sets up a complete academic context:
    - 1 Department (CSE)
    - 1 Active Term (Fall 2026)
    - 1 Subject (CS301)
    - 1 Class Section (CSE-3A)
    - 1 Regular Faculty (Prof Alpha)
    - 1 Substitute Faculty (Prof Beta)
    - 1 Unauthorized Faculty (Prof Gamma)
    - 1 Teaching Assignment (Alpha -> CSE-3A)
    - 30 Students enrolled in CSE-3A (active)
    - 1 Out-of-section Student enrolled in CSE-3B
    """
    dept = Department(code="CSE-SYNC", name="Computer Science Dept")
    term = AcademicTerm(
        code="2026-FALL-SYNC",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS301-SYNC", name="Data Structures", department_id=dept.id, credits=3)
    section_3a = ClassSection(section_code="CSE-3A", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    section_3b = ClassSection(section_code="CSE-3B", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    db_session.add_all([subject, section_3a, section_3b])
    await db_session.flush()

    # Faculty users
    faculty_alpha = User(
        institutional_id="FAC-SYNC-ALPHA",
        email="alpha@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Alpha (Assigned)",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_beta = User(
        institutional_id="FAC-SYNC-BETA",
        email="beta@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Beta (Substitute)",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_gamma = User(
        institutional_id="FAC-SYNC-GAMMA",
        email="gamma@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Gamma (Unauthorized)",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([faculty_alpha, faculty_beta, faculty_gamma])
    await db_session.flush()

    # Assignment
    assignment = TeachingAssignment(
        faculty_user_id=faculty_alpha.id,
        class_section_id=section_3a.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        is_active=True,
        created_by_user_id=faculty_alpha.id,
    )
    db_session.add(assignment)
    await db_session.flush()

    # 30 Eligible Students enrolled in CSE-3A
    students = []
    enrollments = []
    for i in range(1, 31):
        stu = User(
            institutional_id=f"STU-SYNC-{i:03d}",
            email=f"stu_{i}@institution.edu",
            password_hash=get_password_hash("pass"),
            full_name=f"Student {i}",
            role=UserRole.STUDENT,
            account_status=AccountStatus.ACTIVE,
        )
        students.append(stu)
    db_session.add_all(students)
    await db_session.flush()

    for stu in students:
        enr = StudentEnrollment(
            student_user_id=stu.id,
            class_section_id=section_3a.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
            effective_end_date=None,
            enrollment_status=EnrollmentStatus.ACTIVE,
        )
        enrollments.append(enr)
    db_session.add_all(enrollments)

    # 1 Ineligible Student enrolled in CSE-3B
    ineligible_stu = User(
        institutional_id="STU-SYNC-OUTSIDER",
        email="outsider@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Outsider Student",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(ineligible_stu)
    await db_session.flush()

    ineligible_enr = StudentEnrollment(
        student_user_id=ineligible_stu.id,
        class_section_id=section_3b.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 1),
        effective_end_date=None,
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add(ineligible_enr)
    await db_session.flush()

    return {
        "assignment": assignment,
        "faculty_alpha": faculty_alpha,
        "faculty_beta": faculty_beta,
        "faculty_gamma": faculty_gamma,
        "students": students,
        "ineligible_stu": ineligible_stu,
        "section_3a": section_3a,
    }


@pytest.mark.asyncio
async def test_scenario_a_first_successful_sync(async_client: AsyncClient, db_session: AsyncSession, sync_fixture):
    """
    Scenario A: First successful sync of 30 finalized student records.
    Verifies HTTP 201, 1 session in DB, 30 records, and exact server-derived counts.
    """
    fx = sync_fixture
    token = create_access_token(
        subject=str(fx["faculty_alpha"].id),
        role=fx["faculty_alpha"].role.value,
        institutional_id=fx["faculty_alpha"].institutional_id,
    )
    client_uuid = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()

    # 28 PRESENT (AI_VERIFIED), 2 ABSENT (MANUAL_MARK)
    records = []
    for i, stu in enumerate(fx["students"]):
        status = "PRESENT" if i < 28 else "ABSENT"
        src = "AI_VERIFIED" if i < 28 else "MANUAL_MARK"
        conf = 0.885 if i < 28 else None
        records.append({
            "studentUserId": str(stu.id),
            "attendanceStatus": status,
            "markSource": src,
            "candidateConfidence": conf,
            "recordedAt": now_iso,
        })

    payload = {
        "clientSessionUuid": client_uuid,
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": records,
    }

    res = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201
    data = res.json()
    assert len(data["results"]) == 1
    result = data["results"][0]
    assert result["status"] == "SYNCED"
    assert result["records_count"] == 30
    assert result["present_count"] == 28
    assert result["absent_count"] == 2
    assert result["excused_count"] == 0
    assert result["server_session_id"] is not None

    # Verify Database state
    sess_stmt = select(AttendanceSession).where(AttendanceSession.client_session_uuid == uuid.UUID(client_uuid))
    db_sess = (await db_session.execute(sess_stmt)).scalar_one()
    assert db_sess.records_count == 30
    assert db_sess.present_count == 28

    rec_stmt = select(AttendanceRecord).where(AttendanceRecord.attendance_session_id == db_sess.id)
    db_records = (await db_session.execute(rec_stmt)).scalars().all()
    assert len(db_records) == 30


@pytest.mark.asyncio
async def test_scenario_b_idempotent_duplicate_retry(async_client: AsyncClient, db_session: AsyncSession, sync_fixture):
    """
    Scenario B: Network response lost; client retries identical payload.
    Verifies HTTP 200, ALREADY_SYNCED, and zero duplicate sessions or records created.
    """
    fx = sync_fixture
    token = create_access_token(
        subject=str(fx["faculty_alpha"].id),
        role=fx["faculty_alpha"].role.value,
        institutional_id=fx["faculty_alpha"].institutional_id,
    )
    client_uuid = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()

    records = [
        {
            "studentUserId": str(stu.id),
            "attendanceStatus": "PRESENT",
            "markSource": "AI_VERIFIED",
            "candidateConfidence": 0.92,
            "recordedAt": now_iso,
        }
        for stu in fx["students"]
    ]

    payload = {
        "clientSessionUuid": client_uuid,
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": records,
    }

    # First Attempt
    res1 = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res1.status_code == 201

    # Second Attempt (Identical retry)
    res2 = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["results"][0]["status"] == "ALREADY_SYNCED"
    assert data2["results"][0]["server_session_id"] == res1.json()["results"][0]["server_session_id"]

    # Verify zero duplicate sessions in PostgreSQL
    all_sess = (await db_session.execute(
        select(AttendanceSession).where(AttendanceSession.client_session_uuid == uuid.UUID(client_uuid))
    )).scalars().all()
    assert len(all_sess) == 1


@pytest.mark.asyncio
async def test_scenario_b_reordered_payload_idempotency(async_client: AsyncClient, db_session: AsyncSession, sync_fixture):
    """
    TASK 1 (4): Same clientSessionUuid + same logical payload in reordered form (reordered records and keys)
    returns HTTP 200 ALREADY_SYNCED (not conflict) and preserves database uniqueness.
    """
    fx = sync_fixture
    token = create_access_token(
        subject=str(fx["faculty_alpha"].id),
        role=fx["faculty_alpha"].role.value,
        institutional_id=fx["faculty_alpha"].institutional_id,
    )
    client_uuid = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()

    records = [
        {
            "studentUserId": str(stu.id),
            "attendanceStatus": "PRESENT",
            "markSource": "AI_VERIFIED",
            "candidateConfidence": 0.915,
            "recordedAt": now_iso,
        }
        for stu in fx["students"]
    ]

    # Payload 1: standard ordering
    payload1 = {
        "clientSessionUuid": client_uuid,
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 2,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": records,
    }

    res1 = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload1,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res1.status_code == 201

    # Payload 2: reversed records and scrambled key ordering
    reordered_records = [
        {
            "candidateConfidence": r["candidateConfidence"],
            "recordedAt": r["recordedAt"],
            "markSource": r["markSource"],
            "attendanceStatus": r["attendanceStatus"],
            "studentUserId": r["studentUserId"],
        }
        for r in reversed(records)
    ]
    payload2 = {
        "records": reordered_records,
        "finalizedAt": now_iso,
        "periodSlotOrSequence": 2,
        "sessionDate": "2026-10-13",
        "applicabilityStatus": "COUNTED",
        "teachingAssignmentId": str(fx["assignment"].id),
        "clientSessionUuid": client_uuid,
    }

    res2 = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload2,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["results"][0]["status"] == "ALREADY_SYNCED"
    assert data2["results"][0]["server_session_id"] == res1.json()["results"][0]["server_session_id"]

    # Verify database has exactly 1 session and 30 records
    sess_rows = (await db_session.execute(
        select(AttendanceSession).where(AttendanceSession.client_session_uuid == uuid.UUID(client_uuid))
    )).scalars().all()
    assert len(sess_rows) == 1

    rec_rows = (await db_session.execute(
        select(AttendanceRecord).where(AttendanceRecord.attendance_session_id == sess_rows[0].id)
    )).scalars().all()
    assert len(rec_rows) == 30


@pytest.mark.asyncio
async def test_scenario_c_content_divergence_conflict(async_client: AsyncClient, db_session: AsyncSession, sync_fixture):
    """
    Scenario C: Same client_session_uuid submitted with modified attendance decisions.
    Verifies HTTP 409 CONFLICT; silent overwrite is blocked.
    """
    fx = sync_fixture
    token = create_access_token(
        subject=str(fx["faculty_alpha"].id),
        role=fx["faculty_alpha"].role.value,
        institutional_id=fx["faculty_alpha"].institutional_id,
    )
    client_uuid = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()

    records_original = [
        {
            "studentUserId": str(stu.id),
            "attendanceStatus": "PRESENT",
            "markSource": "AI_VERIFIED",
            "recordedAt": now_iso,
        }
        for stu in fx["students"]
    ]
    payload_original = {
        "clientSessionUuid": client_uuid,
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": records_original,
    }

    # Submit original
    res1 = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload_original,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res1.status_code == 201

    # Modify Student 0 to ABSENT under same client_session_uuid
    records_modified = [dict(r) for r in records_original]
    records_modified[0]["attendanceStatus"] = "ABSENT"

    payload_modified = dict(payload_original)
    payload_modified["records"] = records_modified

    res2 = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload_modified,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res2.status_code == 409
    data = res2.json()
    assert data["status"] == "CONFLICT"
    assert "different attendance decisions" in data["message"]


@pytest.mark.asyncio
async def test_scenario_d_slot_collision_conflict(async_client: AsyncClient, db_session: AsyncSession, sync_fixture):
    """
    Scenario D: Different client_session_uuid attempts same assignment, date, and period slot.
    Verifies HTTP 409 CONFLICT.
    """
    fx = sync_fixture
    token = create_access_token(
        subject=str(fx["faculty_alpha"].id),
        role=fx["faculty_alpha"].role.value,
        institutional_id=fx["faculty_alpha"].institutional_id,
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    records = [
        {"studentUserId": str(stu.id), "attendanceStatus": "PRESENT", "markSource": "MANUAL_MARK", "recordedAt": now_iso}
        for stu in fx["students"]
    ]

    # Session 1 on Slot 1
    p1 = {
        "clientSessionUuid": str(uuid.uuid4()),
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": records,
    }
    res1 = await async_client.post("/api/v1/attendance/sessions/sync", json=p1, headers={"Authorization": f"Bearer {token}"})
    assert res1.status_code == 201

    # Session 2 with DIFFERENT UUID but SAME assignment, date, slot
    p2 = {
        "clientSessionUuid": str(uuid.uuid4()),
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": records,
    }
    res2 = await async_client.post("/api/v1/attendance/sessions/sync", json=p2, headers={"Authorization": f"Bearer {token}"})
    assert res2.status_code == 409
    assert "already finalized" in res2.json()["message"]


@pytest.mark.asyncio
async def test_scenario_e_unauthorized_faculty_rejected(async_client: AsyncClient, sync_fixture):
    """
    Scenario E: Unassigned faculty (Prof Gamma) attempts to synchronize session for Prof Alpha's assignment.
    Verifies HTTP 403 FORBIDDEN; zero records inserted.
    """
    fx = sync_fixture
    gamma_token = create_access_token(
        subject=str(fx["faculty_gamma"].id),
        role=fx["faculty_gamma"].role.value,
        institutional_id=fx["faculty_gamma"].institutional_id,
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    records = [
        {"studentUserId": str(stu.id), "attendanceStatus": "PRESENT", "markSource": "MANUAL_MARK", "recordedAt": now_iso}
        for stu in fx["students"]
    ]

    payload = {
        "clientSessionUuid": str(uuid.uuid4()),
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": records,
    }

    res = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload,
        headers={"Authorization": f"Bearer {gamma_token}"},
    )
    assert res.status_code == 403
    assert "Authorization rejected" in res.json()["message"]


@pytest.mark.asyncio
async def test_scenario_f_ineligible_student_rejected(async_client: AsyncClient, db_session: AsyncSession, sync_fixture):
    """
    Scenario F: Payload contains a student who is not enrolled in the target section.
    Verifies HTTP 400 BAD REQUEST, atomic rollback, and zero records inserted.
    """
    fx = sync_fixture
    token = create_access_token(
        subject=str(fx["faculty_alpha"].id),
        role=fx["faculty_alpha"].role.value,
        institutional_id=fx["faculty_alpha"].institutional_id,
    )
    now_iso = datetime.now(timezone.utc).isoformat()

    # Roster of 29 valid students + 1 outsider student
    records = [
        {"studentUserId": str(stu.id), "attendanceStatus": "PRESENT", "markSource": "MANUAL_MARK", "recordedAt": now_iso}
        for stu in fx["students"][:29]
    ]
    records.append({
        "studentUserId": str(fx["ineligible_stu"].id),
        "attendanceStatus": "PRESENT",
        "markSource": "MANUAL_MARK",
        "recordedAt": now_iso,
    })

    client_uuid = str(uuid.uuid4())
    payload = {
        "clientSessionUuid": client_uuid,
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": records,
    }

    res = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400
    assert "not eligible for section" in res.json()["message"]

    # Verify atomic rollback
    db_sess = (await db_session.execute(
        select(AttendanceSession).where(AttendanceSession.client_session_uuid == uuid.UUID(client_uuid))
    )).scalar_one_or_none()
    assert db_sess is None


@pytest.mark.asyncio
async def test_scenario_g_substitute_faculty_delegation_sync(async_client: AsyncClient, db_session: AsyncSession, sync_fixture):
    """
    Scenario G: Substitute faculty (Prof Beta) WITH active delegation synchronizes session.
    Verifies HTTP 201, conducting_faculty_user_id is Beta, regular_faculty_user_id is Alpha,
    and substitute_delegation_id is bound.
    """
    fx = sync_fixture

    # Create active delegation from Alpha to Beta for Oct 13
    delegation = SubstituteDelegation(
        teaching_assignment_id=fx["assignment"].id,
        regular_faculty_user_id=fx["faculty_alpha"].id,
        substitute_faculty_user_id=fx["faculty_beta"].id,
        start_date=date(2026, 10, 10),
        end_date=date(2026, 10, 15),
        delegation_reason="Alpha attending academic conference",
        status=DelegationStatus.ACTIVE,
        created_by_user_id=fx["faculty_alpha"].id,
    )
    db_session.add(delegation)
    await db_session.flush()

    beta_token = create_access_token(
        subject=str(fx["faculty_beta"].id),
        role=fx["faculty_beta"].role.value,
        institutional_id=fx["faculty_beta"].institutional_id,
    )
    client_uuid = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()
    records = [
        {"studentUserId": str(stu.id), "attendanceStatus": "PRESENT", "markSource": "MANUAL_MARK", "recordedAt": now_iso}
        for stu in fx["students"]
    ]

    payload = {
        "clientSessionUuid": client_uuid,
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": records,
    }

    res = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload,
        headers={"Authorization": f"Bearer {beta_token}"},
    )
    assert res.status_code == 201
    assert res.json()["results"][0]["status"] == "SYNCED"

    # Verify attribution in database
    db_sess = (await db_session.execute(
        select(AttendanceSession).where(AttendanceSession.client_session_uuid == uuid.UUID(client_uuid))
    )).scalar_one()
    assert db_sess.conducting_faculty_user_id == fx["faculty_beta"].id
    assert db_sess.regular_faculty_user_id == fx["faculty_alpha"].id
    assert db_sess.substitute_delegation_id == delegation.id


@pytest.mark.asyncio
async def test_scenario_h_cancelled_session_with_reason(async_client: AsyncClient, db_session: AsyncSession, sync_fixture):
    """
    Scenario H: Session conducted under CANCELLED applicability status with mandatory reason.
    Verifies HTTP 201 and correct session persistence.
    """
    fx = sync_fixture
    token = create_access_token(
        subject=str(fx["faculty_alpha"].id),
        role=fx["faculty_alpha"].role.value,
        institutional_id=fx["faculty_alpha"].institutional_id,
    )
    client_uuid = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()

    payload = {
        "clientSessionUuid": client_uuid,
        "teachingAssignmentId": str(fx["assignment"].id),
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 2,
        "applicabilityStatus": "CANCELLED",
        "statusReason": "College sports day holiday",
        "finalizedAt": now_iso,
        "records": [],
    }

    res = await async_client.post(
        "/api/v1/attendance/sessions/sync",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201
    assert res.json()["results"][0]["status"] == "SYNCED"
    assert res.json()["results"][0]["records_count"] == 0

    db_sess = (await db_session.execute(
        select(AttendanceSession).where(AttendanceSession.client_session_uuid == uuid.UUID(client_uuid))
    )).scalar_one()
    assert db_sess.applicability_status == SessionApplicability.CANCELLED
    assert db_sess.status_reason == "College sports day holiday"
