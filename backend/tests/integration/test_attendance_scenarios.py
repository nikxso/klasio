"""End-to-End Attendance Integration Scenarios (Task T082).

Validates the six canonical quickstart scenarios against the live application:
1. Academic structure definition & faculty scoping (SC-001).
2. Late admission enrollment effective dates & denominator exclusion (SC-002, SC-007).
3. Biometric decoupling & manual attendance verification (SC-003).
4. Immediate substitute delegation & automatic expiry (SC-004, SC-005).
5. Multi-session per day & explicit applicability (COUNTED, CANCELLED, EXEMPT).
6. Configurable correction window (7-day default) vs Admin override audit (FR-027).

Uses seeded catalog baseline, real HTTP endpoints, and true database persistence.
"""

from datetime import date, datetime, timedelta, timezone
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scripts.seed_catalog import seed_development_catalog
from src.models.academic import AcademicTerm, ClassSection, Subject
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.attendance import (
    AmendmentRole,
    AttendanceAmendmentAudit,
    AttendanceRecord,
    AttendanceSession,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
)
from src.models.enrollment import EnrollmentStatus, FaceRegistrationStatus, StudentEnrollment, StudentFaceProfile
from src.models.user import AccountStatus, User, UserRole


async def login_user(client: AsyncClient, username: str, password: str = "password") -> tuple[str, dict]:
    """Helper to authenticate through the real POST /api/v1/auth/login endpoint."""
    resp = await client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert resp.status_code == 200, f"Authentication failed for {username}: {resp.text}"
    data = resp.json()
    return data["access_token"], data["user"]


@pytest.fixture
async def scenarios_context(db_session: AsyncSession):
    """Seed baseline catalog and resolve domain entities for quickstart scenarios."""
    summary = await seed_development_catalog(db_session, default_password="password")
    assert summary is not None

    # Resolve users
    users_res = await db_session.execute(select(User))
    users_by_id = {u.institutional_id: u for u in users_res.scalars().all()}

    # Resolve assignments
    ta_res = await db_session.execute(select(TeachingAssignment))
    assignments = ta_res.scalars().all()

    # Find Alan's CSE-3A assignment
    alan_user = users_by_id["prof_alan"]
    ada_user = users_by_id["prof_ada"]

    ta_3a = next(a for a in assignments if a.faculty_user_id == alan_user.id)
    ta_3b = next(a for a in assignments if a.faculty_user_id == ada_user.id)

    # Resolve sections
    sections_res = await db_session.execute(select(ClassSection))
    sections_by_code = {s.section_code: s for s in sections_res.scalars().all()}

    return {
        "admin": users_by_id["admin_meera"],
        "prof_alan": alan_user,
        "prof_ada": ada_user,
        "prof_grace": users_by_id["prof_grace"],
        "s1": users_by_id["S1"],
        "s2": users_by_id["S2"],
        "s3": users_by_id["S3"],
        "ta_3a": ta_3a,
        "ta_3b": ta_3b,
        "section_3a": sections_by_code["CSE-3A"],
        "section_3b": sections_by_code["CSE-3B"],
    }


# ==============================================================================
# Scenario 1: Academic Structure Definition & Faculty Authorization Scoping
# ==============================================================================

@pytest.mark.asyncio
async def test_scenario_1_academic_structure_and_faculty_scoping(
    async_client: AsyncClient,
    scenarios_context: dict,
):
    """
    Scenario 1:
    - Faculty Alan authenticates and retrieves assigned course offerings.
    - Alan accesses assigned CSE-3A roster successfully.
    - Alan is blocked with 403 when attempting to access Ada's CSE-3B roster.
    - Unauthorized Faculty Ada is blocked with 403 when attempting to conduct Alan's CSE-3A session.
    """
    ctx = scenarios_context
    token_alan, user_alan = await login_user(async_client, "prof_alan")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}

    # 1. Verify permitted assignments
    assign_resp = await async_client.get("/api/v1/faculty/assignments", headers=headers_alan)
    assert assign_resp.status_code == 200
    assigned_sections = [a["section_code"] for a in assign_resp.json()]
    assert "CSE-3A" in assigned_sections
    assert "CSE-3B" not in assigned_sections

    # 2. Fetch assigned roster for CSE-3A (Authorized)
    roster_resp = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-09-10",
        headers=headers_alan,
    )
    assert roster_resp.status_code == 200
    roster_data = roster_resp.json()
    assert roster_data["teaching_assignment_id"] == str(ctx["ta_3a"].id)
    assert len(roster_data["eligible_students"]) >= 2

    # 3. Attempt to access CSE-3B roster (Unauthorized cross-assignment query -> 403 Forbidden)
    forbidden_roster = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3b'].id}/roster?session_date=2026-09-10",
        headers=headers_alan,
    )
    assert forbidden_roster.status_code == 403
    assert forbidden_roster.json()["error"] == "OUT_OF_SCOPE"

    # 4. Faculty Ada attempts to conduct session for Alan's CSE-3A assignment -> 403 Forbidden
    token_ada, _ = await login_user(async_client, "prof_ada")
    headers_ada = {"Authorization": f"Bearer {token_ada}"}

    unauthorized_session_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_ada,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-09-10",
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [
                {
                    "student_user_id": str(ctx["s1"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s3"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
            ],
        },
    )
    assert unauthorized_session_resp.status_code == 403
    assert unauthorized_session_resp.json()["error"] == "VALIDATION_FAILED"
    assert "not authorized" in unauthorized_session_resp.json()["message"].lower()


# ==============================================================================
# Scenario 2: Student Enrollment Effective Dates & Late Admission
# ==============================================================================

@pytest.mark.asyncio
async def test_scenario_2_late_admission_and_historical_eligibility(
    async_client: AsyncClient,
    scenarios_context: dict,
    db_session: AsyncSession,
):
    """
    Scenario 2:
    - Student S1 enrolled on 2026-09-01.
    - Conduct 5 sessions between 2026-09-01 and 2026-09-15 (S1 attends 4, misses 1).
    - Student S2 admitted late on 2026-09-20.
    - Conduct session 6 on 2026-09-22 (Both S1 and S2 present).
    - S2 attendance summary: 1 eligible, 1 attended, 100.0%, exactly 0 unearned absences (SC-002, SC-007).
    - S1 attendance summary: 6 eligible, 5 attended, 83.3%.
    - Test enrollment end date boundary: sessions after end date excluded from denominator.
    """
    ctx = scenarios_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}

    prior_session_dates = [
        ("2026-09-01", "PRESENT"),
        ("2026-09-03", "PRESENT"),
        ("2026-09-05", "ABSENT"),
        ("2026-09-08", "PRESENT"),
        ("2026-09-12", "PRESENT"),
    ]

    # Conduct 5 sessions prior to S2's admission (eligible: S1, S3)
    for i, (s_date, s1_status) in enumerate(prior_session_dates, start=1):
        resp = await async_client.post(
            "/api/v1/attendance/sessions",
            headers=headers_alan,
            json={
                "client_session_uuid": str(uuid.uuid4()),
                "teaching_assignment_id": str(ctx["ta_3a"].id),
                "session_date": s_date,
                "period_slot_or_sequence": 1,
                "applicability_status": "COUNTED",
                "records": [
                    {
                        "student_user_id": str(ctx["s1"].id),
                        "attendance_status": s1_status,
                        "mark_source": "MANUAL_MARK",
                    },
                    {
                        "student_user_id": str(ctx["s3"].id),
                        "attendance_status": "PRESENT",
                        "mark_source": "MANUAL_MARK",
                    },
                ],
            },
        )
        assert resp.status_code == 201, f"Failed submitting prior session {i}: {resp.text}"

    # Conduct session 6 on 2026-09-22 (after S2 admission on 2026-09-20; eligible: S1, S2, S3)
    session_6_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-09-22",
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [
                {
                    "student_user_id": str(ctx["s1"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s2"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s3"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
            ],
        },
    )
    assert session_6_resp.status_code == 201

    # 1. Query personal attendance as Student S2
    token_s2, _ = await login_user(async_client, "S2")
    headers_s2 = {"Authorization": f"Bearer {token_s2}"}

    s2_stats_resp = await async_client.get("/api/v1/student/attendance", headers=headers_s2)
    assert s2_stats_resp.status_code == 200
    s2_data = s2_stats_resp.json()
    s2_eligible = sum(s["total_eligible_sessions"] for s in s2_data["subjects"])
    s2_attended = sum(s["attended_sessions"] for s in s2_data["subjects"])
    assert s2_eligible == 1
    assert s2_attended == 1
    assert s2_data["overall_attendance_percentage"] == 100.0

    # 2. Query personal attendance as Student S1
    token_s1, _ = await login_user(async_client, "S1")
    headers_s1 = {"Authorization": f"Bearer {token_s1}"}

    s1_stats_resp = await async_client.get("/api/v1/student/attendance", headers=headers_s1)
    assert s1_stats_resp.status_code == 200
    s1_data = s1_stats_resp.json()
    s1_eligible = sum(s["total_eligible_sessions"] for s in s1_data["subjects"])
    s1_attended = sum(s["attended_sessions"] for s in s1_data["subjects"])
    assert s1_eligible == 6
    assert s1_attended == 5
    assert round(s1_data["overall_attendance_percentage"], 1) == 83.3

    # 3. Verify effective enrollment end date cutoff
    # Create temporary student S4 whose enrollment ends on 2026-09-10
    s4 = User(
        institutional_id="S4-DROPOUT",
        email="student_s4@attendly.edu",
        password_hash=ctx["s1"].password_hash,
        full_name="Student S4 (Transferred early)",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(s4)
    await db_session.flush()

    s4_enr = StudentEnrollment(
        student_user_id=s4.id,
        class_section_id=ctx["section_3a"].id,
        academic_term_id=ctx["ta_3a"].academic_term_id,
        effective_start_date=date(2026, 9, 1),
        effective_end_date=date(2026, 9, 10),
        enrollment_status=EnrollmentStatus.TRANSFERRED,
    )
    db_session.add(s4_enr)
    await db_session.flush()

    token_s4, _ = await login_user(async_client, "S4-DROPOUT")
    s4_stats_resp = await async_client.get(
        "/api/v1/student/attendance",
        headers={"Authorization": f"Bearer {token_s4}"},
    )
    assert s4_stats_resp.status_code == 200
    s4_data = s4_stats_resp.json()
    # S4 is eligible only for sessions conducted on or before 2026-09-10 (4 sessions: Sept 1, 3, 5, 8)
    # The session on 2026-09-12 and 2026-09-22 must NOT be included in S4's denominator
    s4_eligible = sum(s["total_eligible_sessions"] for s in s4_data["subjects"])
    assert s4_eligible == 4


# ==============================================================================
# Scenario 3: Biometric Decoupling & Manual Attendance Verification
# ==============================================================================

@pytest.mark.asyncio
async def test_scenario_3_biometric_decoupling_and_manual_attendance(
    async_client: AsyncClient,
    scenarios_context: dict,
    db_session: AsyncSession,
):
    """
    Scenario 3:
    - Student S3 is enrolled without face registration (face_registration_state = UNREGISTERED).
    - Faculty Alan retrieves roster on 2026-09-23. S3 appears with UNREGISTERED badge.
    - Alan manually marks S3 as PRESENT (MANUAL_MARK).
    - Attendance commits successfully with 100% legal validity (SC-003).
    """
    ctx = scenarios_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}

    # 1. Check roster readiness badge for S3
    roster_resp = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-09-23",
        headers=headers_alan,
    )
    assert roster_resp.status_code == 200
    eligible_students = roster_resp.json()["eligible_students"]

    s3_item = next(s for s in eligible_students if s["institutional_id"] == "S3")
    assert s3_item["face_registration_state"] == "UNREGISTERED"
    assert s3_item["student_name"] == "Student S3"

    # 2. Conduct session with S1 as AI_VERIFIED and S3 as MANUAL_MARK
    client_uuid = uuid.uuid4()
    submit_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(client_uuid),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-09-23",
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [
                {
                    "student_user_id": str(ctx["s1"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "AI_VERIFIED",
                    "candidate_confidence": 0.93,
                },
                {
                    "student_user_id": str(ctx["s2"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s3"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
            ],
        },
    )
    assert submit_resp.status_code == 201

    # 3. Verify in database that S3's record has mark_source = MANUAL_MARK and status = PRESENT
    record_stmt = (
        select(AttendanceRecord)
        .join(AttendanceSession, AttendanceRecord.attendance_session_id == AttendanceSession.id)
        .where(
            AttendanceSession.client_session_uuid == client_uuid,
            AttendanceRecord.student_user_id == ctx["s3"].id,
        )
    )
    s3_record = (await db_session.execute(record_stmt)).scalar_one_or_none()
    assert s3_record is not None
    assert s3_record.attendance_status == AttendanceStatus.PRESENT
    assert s3_record.mark_source == MarkSource.MANUAL_MARK

    # 4. Student S3 queries personal attendance and verifies presence
    token_s3, _ = await login_user(async_client, "S3")
    s3_summary = await async_client.get(
        "/api/v1/student/attendance",
        headers={"Authorization": f"Bearer {token_s3}"},
    )
    assert s3_summary.status_code == 200
    s3_data = s3_summary.json()
    s3_attended = sum(s["attended_sessions"] for s in s3_data["subjects"])
    assert s3_attended >= 1


# ==============================================================================
# Scenario 4: Temporary Substitute Faculty Delegation & Automatic Expiry
# ==============================================================================

@pytest.mark.asyncio
async def test_scenario_4_substitute_delegation_lifecycle_and_expiry(
    async_client: AsyncClient,
    scenarios_context: dict,
    db_session: AsyncSession,
):
    """
    Scenario 4:
    - Regular Faculty Alan delegates authority for CS301 in CSE-3A to Grace for 2026-10-05 only.
    - Delegation activates immediately without administrator approval.
    - Grace logs in, sees delegated assignment, and conducts session on 2026-10-05.
    - Session provenance records Regular Faculty Alan and Conducting Faculty Grace (SC-005).
    - On 2026-10-06, Grace is blocked from accessing the class (expired, SC-004).
    - Grace cannot sub-delegate authority.
    """
    ctx = scenarios_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    token_grace, user_grace = await login_user(async_client, "prof_grace")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}
    headers_grace = {"Authorization": f"Bearer {token_grace}"}

    # 1. Alan creates delegation to Grace for 2026-10-05
    delegation_resp = await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_alan,
        json={
            "substitute_faculty_user_id": str(ctx["prof_grace"].id),
            "start_date": "2026-10-05",
            "end_date": "2026-10-05",
            "delegation_reason": "Department research symposium",
        },
    )
    assert delegation_resp.status_code == 201
    delegation_data = delegation_resp.json()
    assert delegation_data["status"] == "ACTIVE"
    delegation_id = uuid.UUID(delegation_data["id"])

    # 2. Grace queries assignments: delegated assignment appears with delegation metadata
    grace_assignments = await async_client.get(
        "/api/v1/faculty/assignments",
        headers=headers_grace,
    )
    assert grace_assignments.status_code == 200

    # 3. Grace retrieves roster on delegated date (2026-10-05) -> 200 OK
    grace_roster = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-10-05",
        headers=headers_grace,
    )
    assert grace_roster.status_code == 200
    assert len(grace_roster.json()["eligible_students"]) >= 2

    # 4. Grace conducts attendance session on 2026-10-05
    client_uuid_sub = uuid.uuid4()
    sub_session_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_grace,
        json={
            "client_session_uuid": str(client_uuid_sub),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-10-05",
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [
                {
                    "student_user_id": str(ctx["s1"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s2"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s3"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
            ],
        },
    )
    assert sub_session_resp.status_code == 201

    # Verify session provenance in database: dual attribution
    sess_stmt = select(AttendanceSession).where(AttendanceSession.client_session_uuid == client_uuid_sub)
    sess_row = (await db_session.execute(sess_stmt)).scalar_one()
    assert sess_row.regular_faculty_user_id == ctx["prof_alan"].id
    assert sess_row.conducting_faculty_user_id == ctx["prof_grace"].id
    assert sess_row.substitute_delegation_id == delegation_id

    # 5. Grace attempts to conduct attendance on 2026-10-06 (Delegation expired -> 403 Forbidden)
    expired_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_grace,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-10-06",
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [],
        },
    )
    assert expired_resp.status_code == 403
    assert "not authorized" in expired_resp.json()["message"].lower()

    # 6. Grace attempts to sub-delegate authority to Ada -> 403 Forbidden
    sub_delegation_resp = await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_grace,
        json={
            "substitute_faculty_user_id": str(ctx["prof_ada"].id),
            "start_date": "2026-10-05",
            "end_date": "2026-10-05",
            "delegation_reason": "Cascading delegation attempt",
        },
    )
    assert sub_delegation_resp.status_code == 403


# ==============================================================================
# Scenario 5: Multiple Sessions Per Day & Explicit Applicability Status
# ==============================================================================

@pytest.mark.asyncio
async def test_scenario_5_multiple_sessions_per_day_and_applicability(
    async_client: AsyncClient,
    scenarios_context: dict,
):
    """
    Scenario 5:
    - On 2026-10-10, conduct Period 1 as COUNTED (S1 PRESENT).
    - On 2026-10-10, conduct Period 2 as CANCELLED (Power outage reason, records = []).
    - On 2026-10-10, conduct Period 3 as EXEMPT (Workshop reason, records = []).
    - Attempting CANCELLED without reason fails with 400.
    - Duplicate period sequence on same date fails with 409 Conflict.
    - S1 denominator increments by exactly 1 (for Period 1); cancelled & exempt sessions do not penalize.
    """
    ctx = scenarios_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}

    # 1. Period 1: COUNTED
    period_1_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-10-10",
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [
                {
                    "student_user_id": str(ctx["s1"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s2"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s3"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
            ],
        },
    )
    assert period_1_resp.status_code == 201

    # 2. Period 2: CANCELLED with reason
    period_2_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-10-10",
            "period_slot_or_sequence": 2,
            "applicability_status": "CANCELLED",
            "status_reason": "Campus laboratory power outage",
            "records": [],
        },
    )
    assert period_2_resp.status_code == 201

    # 3. Period 3: EXEMPT with reason
    period_3_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-10-10",
            "period_slot_or_sequence": 3,
            "applicability_status": "EXEMPT",
            "status_reason": "Special technical workshop attendance optional",
            "records": [],
        },
    )
    assert period_3_resp.status_code == 201

    # 4. CANCELLED without reason -> 400 / 422 Bad Request / Unprocessable Entity
    invalid_cancel_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-10-10",
            "period_slot_or_sequence": 4,
            "applicability_status": "CANCELLED",
            "status_reason": None,
            "records": [],
        },
    )
    assert invalid_cancel_resp.status_code in (400, 422)
    assert "status_reason" in invalid_cancel_resp.text

    # 5. Duplicate slot (Period 1 again) -> 409 Conflict
    dup_slot_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-10-10",
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [],
        },
    )
    assert dup_slot_resp.status_code == 409

    # 6. Verify S1 personal metrics: only 1 session added to denominator
    token_s1, _ = await login_user(async_client, "S1")
    s1_resp = await async_client.get(
        "/api/v1/student/attendance",
        headers={"Authorization": f"Bearer {token_s1}"},
    )
    assert s1_resp.status_code == 200
    s1_summary = s1_resp.json()
    s1_eligible = sum(s["total_eligible_sessions"] for s in s1_summary["subjects"])
    s1_attended = sum(s["attended_sessions"] for s in s1_summary["subjects"])
    assert s1_eligible == 1
    assert s1_attended == 1
    assert s1_summary["overall_attendance_percentage"] == 100.0


# ==============================================================================
# Scenario 6: Correction Window & Administrative Override Audit
# ==============================================================================

@pytest.mark.asyncio
async def test_scenario_6_correction_window_and_admin_override(
    async_client: AsyncClient,
    scenarios_context: dict,
    db_session: AsyncSession,
):
    """
    Scenario 6:
    - Conduct session 2 days ago (within 7-day default window).
    - Regular Faculty Alan amends S1 from ABSENT to PRESENT -> 201 Created with REGULAR_FACULTY audit.
    - Conduct session 10 days ago (outside 7-day window).
    - Alan attempts amendment -> 403 Forbidden (Window expired).
    - Substitute Faculty Grace attempts amendment -> 403 Forbidden (Substitute locked out).
    - Institutional Admin Meera performs override amendment on 10-day old session -> 201 Created with ADMIN audit.
    - GET /api/v1/attendance/sessions/{id}/amendments returns chronological immutable audit entries.
    """
    ctx = scenarios_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    token_grace, _ = await login_user(async_client, "prof_grace")
    token_admin, _ = await login_user(async_client, "admin_meera")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}
    headers_grace = {"Authorization": f"Bearer {token_grace}"}
    headers_admin = {"Authorization": f"Bearer {token_admin}"}

    today = date.today()
    recent_date = (today - timedelta(days=2)).isoformat()
    old_date = (today - timedelta(days=10)).isoformat()

    # 1. Create recent session (2 days ago, S1 ABSENT)
    uuid_recent = uuid.uuid4()
    recent_sess_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(uuid_recent),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": recent_date,
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [
                {
                    "student_user_id": str(ctx["s1"].id),
                    "attendance_status": "ABSENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s2"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s3"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
            ],
        },
    )
    assert recent_sess_resp.status_code == 201
    recent_session_id = recent_sess_resp.json()["results"][0]["server_session_id"]

    # 2. Alan amends recent session (Within 7-day window) -> 201 Created
    amend_recent_resp = await async_client.post(
        f"/api/v1/attendance/sessions/{recent_session_id}/amendments",
        headers=headers_alan,
        json={
            "student_user_id": str(ctx["s1"].id),
            "new_status": "PRESENT",
            "amendment_reason": "Medical certificate verified by department",
        },
    )
    assert amend_recent_resp.status_code == 201
    amend_recent_data = amend_recent_resp.json()
    assert amend_recent_data["previous_status"] == "ABSENT"
    assert amend_recent_data["new_status"] == "PRESENT"
    assert amend_recent_data["amendment_role"] == "REGULAR_FACULTY"

    # 3. Create old session (10 days ago, S1 ABSENT)
    uuid_old = uuid.uuid4()
    old_sess_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(uuid_old),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": old_date,
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [
                {
                    "student_user_id": str(ctx["s1"].id),
                    "attendance_status": "ABSENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s2"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s3"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
            ],
        },
    )
    assert old_sess_resp.status_code == 201
    old_session_id = old_sess_resp.json()["results"][0]["server_session_id"]

    # 4. Alan attempts amendment on old session (Window expired -> 403 Forbidden)
    alan_expired_amend = await async_client.post(
        f"/api/v1/attendance/sessions/{old_session_id}/amendments",
        headers=headers_alan,
        json={
            "student_user_id": str(ctx["s1"].id),
            "new_status": "PRESENT",
            "amendment_reason": "Late request submitted by student",
        },
    )
    assert alan_expired_amend.status_code == 403
    assert "expired" in alan_expired_amend.json()["message"].lower()

    # 5. Substitute Faculty Grace attempts amendment -> 403 Forbidden
    grace_amend_resp = await async_client.post(
        f"/api/v1/attendance/sessions/{recent_session_id}/amendments",
        headers=headers_grace,
        json={
            "student_user_id": str(ctx["s1"].id),
            "new_status": "ABSENT",
            "amendment_reason": "Substitute faculty override attempt",
        },
    )
    assert grace_amend_resp.status_code == 403
    assert "substitute" in grace_amend_resp.json()["message"].lower()

    # 6. Admin Meera performs override amendment on old session -> 201 Created
    admin_override_resp = await async_client.post(
        f"/api/v1/attendance/sessions/{old_session_id}/amendments",
        headers=headers_admin,
        json={
            "student_user_id": str(ctx["s1"].id),
            "new_status": "PRESENT",
            "amendment_reason": "HOD administrative approval ref #491",
        },
    )
    assert admin_override_resp.status_code == 201
    admin_data = admin_override_resp.json()
    assert admin_data["amendment_role"] == "ADMIN"
    assert admin_data["new_status"] == "PRESENT"

    # 7. Query chronological amendment audit history for recent session
    history_resp = await async_client.get(
        f"/api/v1/attendance/sessions/{recent_session_id}/amendments",
        headers=headers_alan,
    )
    assert history_resp.status_code == 200
    history = history_resp.json()
    assert len(history) == 1
    assert history[0]["amendment_role"] == "REGULAR_FACULTY"
    assert history[0]["previous_status"] == "ABSENT"
    assert history[0]["new_status"] == "PRESENT"
    assert "Medical certificate" in history[0]["amendment_reason"]
