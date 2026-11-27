"""
Integration tests for Administrative Attendance Reporting and Controlled CSV Export:
- GET /api/v1/analytics/assignments/{teaching_assignment_id}/export (Roster and Sessions CSV)
- GET /api/v1/analytics/overview/export (Overview CSV)
- Scoping and role boundaries: Admin (all), Faculty (assigned/delegated), Student (403 forbidden)
- Date range filtering and shortage filtering
- Reconciling export counts with analytics endpoints
- Formula injection protection in output CSV
- Operational audit logging in report_export_audits
"""

import csv
from datetime import date, datetime, timedelta, timezone
import io
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import (
    DEFAULT_CAMPUS_ID,
    DEFAULT_INSTITUTION_ID,
    AcademicTerm,
    ClassSection,
    Department,
    Subject,
    TermStatus,
)
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.attendance import (
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
)
from src.models.audit import ReportExportAudit
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import AccountStatus, User, UserRole


@pytest.fixture
async def export_api_env(db_session: AsyncSession) -> dict:
    """Setup academic hierarchy, assignments, students, sessions, and records."""
    # 1. Users
    admin = User(
        institutional_id="ADM-EXP-01",
        email="admin_exp@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Dean Administrator",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    fac_assigned = User(
        institutional_id="FAC-EXP-01",
        email="fac1_exp@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Ada Lovelace",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_substitute = User(
        institutional_id="FAC-EXP-02",
        email="fac2_exp@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Alan Turing",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_unauthorized = User(
        institutional_id="FAC-EXP-03",
        email="fac3_exp@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Charles Babbage",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student_a = User(
        institutional_id="STU-EXP-01",
        email="stu1_exp@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Alice Shortage",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    student_b = User(
        institutional_id="STU-EXP-02",
        email="stu2_exp@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="=Bob Dangerous",  # Malicious formula name test
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, fac_assigned, fac_substitute, fac_unauthorized, student_a, student_b])
    await db_session.flush()

    # 2. Academic structure
    unique_suffix = uuid.uuid4().hex[:6]
    dept = Department(code=f"CSE_{unique_suffix}", name="Computer Science & Engineering", institution_id=DEFAULT_INSTITUTION_ID)
    term = AcademicTerm(
        code=f"TERM_{unique_suffix}",
        name="Autumn 2026 Term",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
        institution_id=DEFAULT_INSTITUTION_ID,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    sub_cs301 = Subject(code=f"CS_{unique_suffix}", name="Data Structures", department_id=dept.id, credits=4, institution_id=DEFAULT_INSTITUTION_ID)
    sec_a = ClassSection(
        section_code=f"SEC_{unique_suffix}",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2026,
        institution_id=DEFAULT_INSTITUTION_ID,
        campus_id=DEFAULT_CAMPUS_ID,
    )
    db_session.add_all([sub_cs301, sec_a])
    await db_session.flush()

    # Teaching Assignment
    ta_a = TeachingAssignment(
        faculty_user_id=fac_assigned.id,
        class_section_id=sec_a.id,
        subject_id=sub_cs301.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add(ta_a)
    await db_session.flush()

    # Active delegation to fac_substitute covering today
    today = date.today()
    delegation = SubstituteDelegation(
        teaching_assignment_id=ta_a.id,
        regular_faculty_user_id=fac_assigned.id,
        substitute_faculty_user_id=fac_substitute.id,
        created_by_user_id=fac_assigned.id,
        delegation_reason="Academic conference attendance and research symposium",
        start_date=today - timedelta(days=7),
        end_date=today + timedelta(days=7),
        status=DelegationStatus.ACTIVE,
    )
    db_session.add(delegation)
    await db_session.flush()

    # Enrollments
    enr_a = StudentEnrollment(
        student_user_id=student_a.id,
        class_section_id=sec_a.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 15),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    enr_b = StudentEnrollment(
        student_user_id=student_b.id,
        class_section_id=sec_a.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 15),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add_all([enr_a, enr_b])
    await db_session.flush()

    # 3. Sessions & Records
    # Session 1: COUNTED -> Student A ABSENT, Student B PRESENT
    s1 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=date(2026, 9, 1),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=fac_assigned.id,
        conducting_faculty_user_id=fac_assigned.id,
        finalized_at=datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc),
    )
    # Session 2: COUNTED -> Student A ABSENT, Student B PRESENT
    s2 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=date(2026, 9, 8),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=fac_assigned.id,
        conducting_faculty_user_id=fac_assigned.id,
        finalized_at=datetime(2026, 9, 8, 10, 0, tzinfo=timezone.utc),
    )
    # Session 3: CANCELLED -> Status reason recorded
    s3 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=date(2026, 9, 15),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.CANCELLED,
        status_reason="University convocation ceremony",
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=fac_assigned.id,
        conducting_faculty_user_id=fac_assigned.id,
        finalized_at=datetime(2026, 9, 15, 10, 0, tzinfo=timezone.utc),
    )
    # Session 4: Unfinalized (DRAFT) -> Must be excluded!
    s4_draft = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_a.id,
        session_date=date(2026, 9, 22),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.DRAFT,
        regular_faculty_user_id=fac_assigned.id,
        conducting_faculty_user_id=fac_assigned.id,
        finalized_at=datetime(2026, 9, 22, 10, 0, tzinfo=timezone.utc),
    )
    db_session.add_all([s1, s2, s3, s4_draft])
    await db_session.flush()

    # Records for S1 and S2
    r1_a = AttendanceRecord(
        attendance_session_id=s1.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc),
    )
    r1_b = AttendanceRecord(
        attendance_session_id=s1.id,
        student_user_id=student_b.id,
        attendance_status=AttendanceStatus.PRESENT,
        mark_source=MarkSource.AI_VERIFIED,
        recorded_at=datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc),
    )
    r2_a = AttendanceRecord(
        attendance_session_id=s2.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=datetime(2026, 9, 8, 10, 0, tzinfo=timezone.utc),
    )
    r2_b = AttendanceRecord(
        attendance_session_id=s2.id,
        student_user_id=student_b.id,
        attendance_status=AttendanceStatus.PRESENT,
        mark_source=MarkSource.AI_VERIFIED,
        recorded_at=datetime(2026, 9, 8, 10, 0, tzinfo=timezone.utc),
    )
    db_session.add_all([r1_a, r1_b, r2_a, r2_b])
    await db_session.commit()

    # Tokens
    token_admin = create_access_token(str(admin.id), admin.role.value, admin.institutional_id)
    token_fac_assigned = create_access_token(str(fac_assigned.id), fac_assigned.role.value, fac_assigned.institutional_id)
    token_fac_sub = create_access_token(str(fac_substitute.id), fac_substitute.role.value, fac_substitute.institutional_id)
    token_fac_unauth = create_access_token(str(fac_unauthorized.id), fac_unauthorized.role.value, fac_unauthorized.institutional_id)
    token_student = create_access_token(str(student_a.id), student_a.role.value, student_a.institutional_id)

    return {
        "admin": admin,
        "fac_assigned": fac_assigned,
        "fac_substitute": fac_substitute,
        "fac_unauthorized": fac_unauthorized,
        "student_a": student_a,
        "student_b": student_b,
        "ta_a": ta_a,
        "term": term,
        "token_admin": token_admin,
        "token_fac_assigned": token_fac_assigned,
        "token_fac_sub": token_fac_sub,
        "token_fac_unauth": token_fac_unauth,
        "token_student": token_student,
    }


@pytest.mark.asyncio
async def test_admin_export_assignment_roster_csv(async_client: AsyncClient, export_api_env: dict, db_session: AsyncSession):
    """
    Test Admin exporting section attendance roster to CSV:
    - 200 OK
    - Content-Type: text/csv; charset=utf-8
    - Proper headers and student rows
    - Formula injection neutralized ('=Bob Dangerous -> ''=Bob Dangerous')
    - Audit entry logged
    """
    ta_id = export_api_env["ta_a"].id
    headers = {"Authorization": f"Bearer {export_api_env['token_admin']}"}
    res = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_id}/export?report_type=roster",
        headers=headers,
    )
    assert res.status_code == 200
    assert "text/csv" in res.headers["content-type"]
    assert "attendance_roster" in res.headers["content-disposition"]

    # Read CSV text
    csv_text = res.text
    assert csv_text.startswith("\ufeff")  # UTF-8 BOM present
    reader = csv.reader(io.StringIO(csv_text.lstrip("\ufeff")))
    rows = list(reader)

    # 1 header + 2 student rows
    assert len(rows) == 3
    headers_row = rows[0]
    assert "Institutional ID" in headers_row
    assert "Student Name" in headers_row
    assert "Total Eligible Sessions" in headers_row
    assert "Shortage Status" in headers_row

    # Student A (Alice) row
    alice_row = next(r for r in rows[1:] if "STU-EXP-01" in r[0])
    assert alice_row[1] == "Alice Shortage"
    assert alice_row[5] == "2"  # Total eligible (S1 and S2; S3 cancelled is excluded)
    assert alice_row[6] == "0"  # Attended
    assert alice_row[7] == "0.0%"  # Attendance percentage
    assert alice_row[9] == "YES"  # Shortage

    # Student B (=Bob Dangerous) row: formula trigger sanitized!
    bob_row = next(r for r in rows[1:] if "STU-EXP-02" in r[0])
    assert bob_row[1] == "'=Bob Dangerous"  # Prepended with single quote!
    assert bob_row[5] == "2"
    assert bob_row[6] == "2"
    assert bob_row[7] == "100.0%"
    assert bob_row[9] == "NO"

    # Verify audit entry recorded
    audit_stmt = select(ReportExportAudit).where(
        ReportExportAudit.teaching_assignment_id == ta_id
    )
    audit_res = await db_session.execute(audit_stmt)
    audits = audit_res.scalars().all()
    assert len(audits) >= 1
    assert audits[0].report_type == "ASSIGNMENT_ROSTER"
    assert audits[0].row_count == 2


@pytest.mark.asyncio
async def test_faculty_export_scoping_and_unauthorized_rejection(async_client: AsyncClient, export_api_env: dict):
    """
    Test Faculty authorization scoping:
    - Assigned faculty -> 200 OK
    - Active substitute faculty -> 200 OK
    - Unauthorized faculty -> 403 Forbidden
    """
    ta_id = export_api_env["ta_a"].id

    # 1. Assigned faculty: 200 OK
    h_assigned = {"Authorization": f"Bearer {export_api_env['token_fac_assigned']}"}
    res_assigned = await async_client.get(f"/api/v1/analytics/assignments/{ta_id}/export", headers=h_assigned)
    assert res_assigned.status_code == 200

    # 2. Active substitute faculty: 200 OK
    h_sub = {"Authorization": f"Bearer {export_api_env['token_fac_sub']}"}
    res_sub = await async_client.get(f"/api/v1/analytics/assignments/{ta_id}/export", headers=h_sub)
    assert res_sub.status_code == 200

    # 3. Unauthorized faculty: 403 Forbidden
    h_unauth = {"Authorization": f"Bearer {export_api_env['token_fac_unauth']}"}
    res_unauth = await async_client.get(f"/api/v1/analytics/assignments/{ta_id}/export", headers=h_unauth)
    assert res_unauth.status_code == 403


@pytest.mark.asyncio
async def test_student_forbidden_from_reports_and_export(async_client: AsyncClient, export_api_env: dict):
    """
    Verify student role enforcement: Students must be rejected with HTTP 403 from all export endpoints.
    """
    ta_id = export_api_env["ta_a"].id
    h_student = {"Authorization": f"Bearer {export_api_env['token_student']}"}

    # Section export
    res_sec = await async_client.get(f"/api/v1/analytics/assignments/{ta_id}/export", headers=h_student)
    assert res_sec.status_code == 403

    # Overview export
    res_over = await async_client.get("/api/v1/analytics/overview/export", headers=h_student)
    assert res_over.status_code == 403


@pytest.mark.asyncio
async def test_export_sessions_log_csv(async_client: AsyncClient, export_api_env: dict):
    """
    Test report_type=sessions:
    - Chronological log of session marks
    - Contains finalized sessions only (excludes draft)
    - Includes cancelled session with status reason
    """
    ta_id = export_api_env["ta_a"].id
    h_admin = {"Authorization": f"Bearer {export_api_env['token_admin']}"}
    res = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_id}/export?report_type=sessions",
        headers=h_admin,
    )
    assert res.status_code == 200
    reader = csv.reader(io.StringIO(res.text.lstrip("\ufeff")))
    rows = list(reader)

    # Header
    assert rows[0][0] == "Session Date"
    assert rows[0][3] == "Applicability"
    assert rows[0][7] == "Attendance Status"

    # Check that draft session (Sept 22) is NOT in the export
    sept_22_rows = [r for r in rows if "2026-09-22" in r[0]]
    assert len(sept_22_rows) == 0

    # Check cancelled session (Sept 15) has status reason
    sept_15_rows = [r for r in rows if "2026-09-15" in r[0]]
    assert len(sept_15_rows) > 0
    assert sept_15_rows[0][3] == "CANCELLED"
    assert sept_15_rows[0][4] == "University convocation ceremony"


@pytest.mark.asyncio
async def test_export_shortage_only_filter(async_client: AsyncClient, export_api_env: dict):
    """
    Test shortage_only=true:
    - Filters roster export to strictly students with attendance percentage < threshold.
    """
    ta_id = export_api_env["ta_a"].id
    h_admin = {"Authorization": f"Bearer {export_api_env['token_admin']}"}
    res = await async_client.get(
        f"/api/v1/analytics/assignments/{ta_id}/export?report_type=roster&shortage_only=true",
        headers=h_admin,
    )
    assert res.status_code == 200
    reader = csv.reader(io.StringIO(res.text.lstrip("\ufeff")))
    rows = list(reader)

    # 1 header + only Alice (Shortage). Bob (100%) must be filtered out!
    assert len(rows) == 2
    assert "STU-EXP-01" in rows[1][0]
    assert rows[1][9] == "YES"


@pytest.mark.asyncio
async def test_export_overview_csv(async_client: AsyncClient, export_api_env: dict):
    """
    Test institutional overview export:
    - Summarizes all sections
    - Returns proper headers and section rows
    """
    h_admin = {"Authorization": f"Bearer {export_api_env['token_admin']}"}
    res = await async_client.get("/api/v1/analytics/overview/export", headers=h_admin)
    assert res.status_code == 200
    assert "text/csv" in res.headers["content-type"]
    assert "attendance_overview" in res.headers["content-disposition"]

    reader = csv.reader(io.StringIO(res.text.lstrip("\ufeff")))
    rows = list(reader)
    assert len(rows) >= 2  # Header + at least Section A
    assert rows[0][0] == "Section Code"
    assert rows[0][1] == "Subject Code"
    assert export_api_env["ta_a"].class_section.section_code in [r[0] for r in rows[1:]]
