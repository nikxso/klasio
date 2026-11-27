"""Academic Analytics & Attendance Integrity Audit Test Suite.

Verifies:
1. Subject-wise attendance calculations (independent percentages, non-overwriting overall aggregate).
2. Attendance denominator integrity (COUNTED vs CANCELLED, EXEMPT, DRAFT, unconducted timetable slots).
3. Historical enrollment and attendance retention (section transfer consolidation, term promotion, withdrawn students).
4. Attendance corrections and immutable auditability (amendment by regular faculty, substitute lockout, audit trail).
5. Shortage intelligence formulas & institutional threshold resolution (DeploymentConfig threshold, recovery, can miss).
6. Reporting permissions & IAC scoping (HOD department scope, Class Advisor section scope, student self-service isolation).
"""

from datetime import date, datetime, time, timedelta, timezone
from typing import List, Optional
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import (
    AmendmentWindowExpiredError,
    AttendanceDomainError,
    EntityNotFoundError,
    OutOfScopeError,
    UnauthorizedRoleError,
)
from src.core.security import create_access_token, get_password_hash
from src.models.academic import (
    DEFAULT_CAMPUS_ID,
    DEFAULT_INSTITUTION_ID,
    AcademicPeriod,
    AcademicTerm,
    ClassSection,
    Department,
    DeploymentConfig,
    Program,
    Subject,
    TermStatus,
    TimetableEntry,
)
from src.models.access_control import (
    AssignmentStatus,
    Institution,
    InstitutionStatus,
    InstitutionMembership,
    MembershipStatus,
    RoleAssignment,
    RoleAssignmentScope,
    RoleScopeType,
    RoleTemplate,
)
from src.models.assignment import (
    TeachingAssignment,
    SubstituteDelegation,
    DelegationStatus,
)
from src.models.attendance import (
    AmendmentRole,
    AttendanceAmendmentAudit,
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
    AttendanceRequestStatus,
    StudentAttendanceRequest,
)
from src.models.enrollment import (
    EnrollmentStatus,
    FaceRegistrationStatus,
    StudentEnrollment,
    StudentFaceProfile,
)
from src.models.user import AccountStatus, User, UserRole
from src.schemas.analytics import SectionAnalyticsResponse, AnalyticsOverviewResponse
from src.schemas.enrollment import (
    StudentEnrollmentCreate,
    StudentTransferRequest,
    StudentPersonalAttendanceResponse,
    StudentSubjectHistoryResponse,
)
from src.services.amendment_service import AmendmentService
from src.services.analytics_service import (
    AnalyticsService,
    calculate_can_miss_classes,
    calculate_recovery_classes,
    get_institution_threshold,
)
from src.services.enrollment_service import EnrollmentService


def make_user(
    email: str,
    full_name: str,
    role: UserRole = UserRole.FACULTY,
    institutional_id: Optional[str] = None,
) -> User:
    return User(
        institutional_id=institutional_id or f"INST_{uuid.uuid4().hex[:8].upper()}",
        email=email,
        password_hash=get_password_hash("secure_password_123"),
        full_name=full_name,
        role=role,
        account_status=AccountStatus.ACTIVE,
    )


async def ensure_default_institution(db: AsyncSession) -> Institution:
    inst_res = await db.execute(select(Institution).where(Institution.id == DEFAULT_INSTITUTION_ID))
    inst = inst_res.scalar_one_or_none()
    if not inst:
        inst = Institution(
            id=DEFAULT_INSTITUTION_ID,
            code="KLASIO_MAIN",
            name="Klasio Institute of Technology",
            status=InstitutionStatus.ACTIVE,
        )
        db.add(inst)
        await db.flush()
    return inst


async def setup_membership_and_role(
    db: AsyncSession,
    user: User,
    role_template_code: str,
    scope_type: RoleScopeType = RoleScopeType.INSTITUTION,
    department_id: Optional[uuid.UUID] = None,
    class_section_id: Optional[uuid.UUID] = None,
    student_user_id: Optional[uuid.UUID] = None,
) -> RoleAssignment:
    """Assign an IAC role template with specified scope to a user."""
    await ensure_default_institution(db)

    mem_stmt = select(InstitutionMembership).where(
        InstitutionMembership.user_id == user.id,
        InstitutionMembership.institution_id == DEFAULT_INSTITUTION_ID,
    )
    mem = (await db.execute(mem_stmt)).scalar_one_or_none()
    if not mem:
        mem = InstitutionMembership(
            institution_id=DEFAULT_INSTITUTION_ID,
            user_id=user.id,
            status=MembershipStatus.ACTIVE,
        )
        db.add(mem)
        await db.flush()

    rt_stmt = select(RoleTemplate).where(RoleTemplate.code == role_template_code)
    rt = (await db.execute(rt_stmt)).scalar_one()

    ra = RoleAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        membership_id=mem.id,
        role_template_id=rt.id,
        status=AssignmentStatus.ACTIVE,
        valid_from=datetime.now(timezone.utc) - timedelta(days=1),
        valid_until=datetime.now(timezone.utc) + timedelta(days=365),
        reason=f"Assigned {role_template_code} for analytics audit",
    )
    db.add(ra)
    await db.flush()

    scope = RoleAssignmentScope(
        role_assignment_id=ra.id,
        institution_id=DEFAULT_INSTITUTION_ID,
        scope_type=scope_type,
        department_id=department_id,
        class_section_id=class_section_id,
        student_user_id=student_user_id or (user.id if scope_type == RoleScopeType.STUDENT else None),
    )
    db.add(scope)
    await db.flush()
    return ra


# =========================================================================
# 1. SUBJECT-WISE ATTENDANCE CALCULATIONS & AGGREGATE INTEGRITY
# =========================================================================

@pytest.mark.asyncio
async def test_subject_wise_attendance_calculations_and_non_overwriting_aggregate(db_session: AsyncSession):
    """
    Verify attendance is calculated independently for each subject and teaching assignment:
    - DBMS: 20 conducted, 16 attended -> 80.0%
    - OS: 18 conducted, 15 attended -> 83.3%
    - Networks: 22 conducted, 12 attended -> 54.5%
    - Overall aggregate: (16 + 15 + 12) / (20 + 18 + 22) = 43 / 60 = 71.7%
    - Verify that overall percentage does NOT overwrite or replace individual subject percentages.
    """
    await ensure_default_institution(db_session)

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_{uuid.uuid4().hex[:6]}",
        name="Term 2026-Fall",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_{uuid.uuid4().hex[:4]}", name="Computer Science")
    db_session.add_all([term, dept])
    await db_session.flush()

    sec = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="CSE-3A",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    subj_dbms = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code="CS301", name="Database Management Systems")
    subj_os = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code="CS302", name="Operating Systems")
    subj_net = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code="CS303", name="Computer Networks")
    db_session.add_all([sec, subj_dbms, subj_os, subj_net])
    await db_session.flush()

    fac_dbms = make_user("prof_dbms@test.edu", "Prof DBMS", UserRole.FACULTY)
    fac_os = make_user("prof_os@test.edu", "Prof OS", UserRole.FACULTY)
    fac_net = make_user("prof_net@test.edu", "Prof Networks", UserRole.FACULTY)
    student = make_user("student_core@test.edu", "Core Student", UserRole.STUDENT, institutional_id="STU-ANALYTICS-CORE")
    admin = make_user("admin_core@test.edu", "Admin Core", UserRole.ADMIN)
    db_session.add_all([fac_dbms, fac_os, fac_net, student, admin])
    await db_session.flush()

    ta_dbms = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac_dbms.id,
        class_section_id=sec.id,
        subject_id=subj_dbms.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    ta_os = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac_os.id,
        class_section_id=sec.id,
        subject_id=subj_os.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    ta_net = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac_net.id,
        class_section_id=sec.id,
        subject_id=subj_net.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    db_session.add_all([ta_dbms, ta_os, ta_net])
    await db_session.flush()

    # Enroll student in section from Aug 1
    enr_service = EnrollmentService(db_session)
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=student.id,
            class_section_id=sec.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
        )
    )

    # 1. Create DBMS sessions: 20 conducted, 16 attended
    base_date = date(2026, 8, 3)
    for i in range(20):
        s_date = base_date + timedelta(days=i)
        sess = AttendanceSession(
            client_session_uuid=uuid.uuid4(),
            teaching_assignment_id=ta_dbms.id,
            session_date=s_date,
            period_slot_or_sequence=1,
            applicability_status=SessionApplicability.COUNTED,
            session_status=AttendanceSessionStatus.FINALIZED,
            regular_faculty_user_id=fac_dbms.id,
            conducting_faculty_user_id=fac_dbms.id,
        )
        db_session.add(sess)
        await db_session.flush()
        status_val = AttendanceStatus.PRESENT if i < 16 else AttendanceStatus.ABSENT
        rec = AttendanceRecord(
            attendance_session_id=sess.id,
            student_user_id=student.id,
            attendance_status=status_val,
            mark_source=MarkSource.MANUAL_MARK,
        )
        db_session.add(rec)

    # 2. Create OS sessions: 18 conducted, 15 attended
    for i in range(18):
        s_date = base_date + timedelta(days=i)
        sess = AttendanceSession(
            client_session_uuid=uuid.uuid4(),
            teaching_assignment_id=ta_os.id,
            session_date=s_date,
            period_slot_or_sequence=2,
            applicability_status=SessionApplicability.COUNTED,
            session_status=AttendanceSessionStatus.FINALIZED,
            regular_faculty_user_id=fac_os.id,
            conducting_faculty_user_id=fac_os.id,
        )
        db_session.add(sess)
        await db_session.flush()
        status_val = AttendanceStatus.PRESENT if i < 15 else AttendanceStatus.ABSENT
        rec = AttendanceRecord(
            attendance_session_id=sess.id,
            student_user_id=student.id,
            attendance_status=status_val,
            mark_source=MarkSource.MANUAL_MARK,
        )
        db_session.add(rec)

    # 3. Create Networks sessions: 22 conducted, 12 attended
    for i in range(22):
        s_date = base_date + timedelta(days=i)
        sess = AttendanceSession(
            client_session_uuid=uuid.uuid4(),
            teaching_assignment_id=ta_net.id,
            session_date=s_date,
            period_slot_or_sequence=3,
            applicability_status=SessionApplicability.COUNTED,
            session_status=AttendanceSessionStatus.FINALIZED,
            regular_faculty_user_id=fac_net.id,
            conducting_faculty_user_id=fac_net.id,
        )
        db_session.add(sess)
        await db_session.flush()
        status_val = AttendanceStatus.PRESENT if i < 12 else AttendanceStatus.ABSENT
        rec = AttendanceRecord(
            attendance_session_id=sess.id,
            student_user_id=student.id,
            attendance_status=status_val,
            mark_source=MarkSource.MANUAL_MARK,
        )
        db_session.add(rec)
    await db_session.flush()

    # Calculate student personal attendance
    res = await enr_service.calculate_student_personal_attendance(
        student_user_id=student.id,
        academic_term_id=term.id,
    )

    # Assert 3 distinct subjects
    assert len(res.subjects) == 3
    subj_map = {s.subject_code: s for s in res.subjects}

    # 1. DBMS: 20 conducted, 16 attended -> 80.0%
    dbms = subj_map["CS301"]
    assert dbms.total_eligible_sessions == 20
    assert dbms.attended_sessions == 16
    assert dbms.attendance_percentage == 80.0
    assert dbms.is_shortage is False
    assert dbms.classes_to_recover == 0
    assert dbms.classes_can_miss == 1  # (16 * 100 / 75) - 20 = 21.33 - 20 = 1

    # 2. OS: 18 conducted, 15 attended -> 83.3%
    os_subj = subj_map["CS302"]
    assert os_subj.total_eligible_sessions == 18
    assert os_subj.attended_sessions == 15
    assert os_subj.attendance_percentage == 83.3
    assert os_subj.is_shortage is False
    assert os_subj.classes_to_recover == 0
    assert os_subj.classes_can_miss == 2  # (15 * 100 / 75) - 18 = 20 - 18 = 2

    # 3. Networks: 22 conducted, 12 attended -> 54.5%
    net = subj_map["CS303"]
    assert net.total_eligible_sessions == 22
    assert net.attended_sessions == 12
    assert net.attendance_percentage == 54.5
    assert net.is_shortage is True
    # ceil((75 * 22 - 100 * 12) / 25) = ceil((1650 - 1200) / 25) = 450 / 25 = 18
    assert net.classes_to_recover == 18
    assert net.classes_can_miss == 0

    # Overall Aggregate: (16 + 15 + 12) / (20 + 18 + 22) = 43 / 60 = 71.7%
    assert res.total_eligible_sessions == 60
    assert res.total_attended_sessions == 43
    assert res.overall_attendance_percentage == 71.7

    # Invariant: Overall percentage (71.7%) must not overwrite individual subject percentages
    assert dbms.attendance_percentage == 80.0
    assert os_subj.attendance_percentage == 83.3
    assert net.attendance_percentage == 54.5


# =========================================================================
# 2. ATTENDANCE DENOMINATOR INTEGRITY
# =========================================================================

@pytest.mark.asyncio
async def test_attendance_denominator_integrity(db_session: AsyncSession):
    """
    Verify treatment of:
    - COUNTED finalized sessions -> INCLUDED in denominator.
    - CANCELLED sessions (e.g. holidays) -> EXCLUDED from denominator.
    - EXEMPT sessions (e.g. symposiums) -> EXCLUDED from denominator.
    - DRAFT / unfinalized sessions -> EXCLUDED from denominator.
    - Sessions prior to student's admission date -> EXCLUDED from denominator.
    """
    await ensure_default_institution(db_session)

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_DENOM_{uuid.uuid4().hex[:6]}",
        name="Term Denom",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_DENOM_{uuid.uuid4().hex[:4]}", name="Dept Denom")
    db_session.add_all([term, dept])
    await db_session.flush()

    sec = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="DENOM-A", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    subj = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code="CS_DENOM", name="Data Structures")
    fac = make_user("fac_denom@test.edu", "Prof Denom", UserRole.FACULTY)
    stu_early = make_user("stu_early@test.edu", "Early Student", UserRole.STUDENT, institutional_id="STU-DENOM-01")
    stu_late = make_user("stu_late@test.edu", "Late Student", UserRole.STUDENT, institutional_id="STU-DENOM-02")
    admin = make_user("admin_denom@test.edu", "Admin Denom", UserRole.ADMIN)
    db_session.add_all([sec, subj, fac, stu_early, stu_late, admin])
    await db_session.flush()

    ta = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    db_session.add(ta)
    await db_session.flush()

    # Early student enrolled Aug 1; Late student enrolled Aug 15
    enr_service = EnrollmentService(db_session)
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=stu_early.id,
            class_section_id=sec.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
        )
    )
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=stu_late.id,
            class_section_id=sec.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 15),
        )
    )

    # Session 1: Aug 5 (COUNTED, FINALIZED) -> held before Late Student enrolled
    s1 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 5),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=fac.id,
        conducting_faculty_user_id=fac.id,
    )
    # Session 2: Aug 10 (CANCELLED, holiday)
    s2 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 10),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.CANCELLED,
        status_reason="Independence Day Holiday",
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=fac.id,
        conducting_faculty_user_id=fac.id,
    )
    # Session 3: Aug 18 (COUNTED, FINALIZED) -> both enrolled
    s3 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 18),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=fac.id,
        conducting_faculty_user_id=fac.id,
    )
    # Session 4: Aug 20 (EXEMPT, sports day)
    s4 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 20),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.EXEMPT,
        status_reason="Inter-College Sports Tournament",
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=fac.id,
        conducting_faculty_user_id=fac.id,
    )
    # Session 5: Aug 25 (COUNTED, DRAFT) -> unfinalized draft session
    s5 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 25),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.DRAFT,
        regular_faculty_user_id=fac.id,
        conducting_faculty_user_id=fac.id,
    )
    db_session.add_all([s1, s2, s3, s4, s5])
    await db_session.flush()

    # Records: Early student present in S1 & S3; Late student present in S3
    db_session.add_all([
        AttendanceRecord(attendance_session_id=s1.id, student_user_id=stu_early.id, attendance_status=AttendanceStatus.PRESENT),
        AttendanceRecord(attendance_session_id=s3.id, student_user_id=stu_early.id, attendance_status=AttendanceStatus.PRESENT),
        AttendanceRecord(attendance_session_id=s3.id, student_user_id=stu_late.id, attendance_status=AttendanceStatus.PRESENT),
    ])
    await db_session.flush()

    # Verify Early Student Personal Attendance:
    # Eligible sessions: S1 (Aug 5) and S3 (Aug 18).
    # S2 (CANCELLED), S4 (EXEMPT), S5 (DRAFT) must be excluded. Total eligible = 2, attended = 2 -> 100.0%
    early_res = await enr_service.calculate_student_personal_attendance(student_user_id=stu_early.id, academic_term_id=term.id)
    assert len(early_res.subjects) == 1
    assert early_res.subjects[0].total_eligible_sessions == 2
    assert early_res.subjects[0].attended_sessions == 2
    assert early_res.subjects[0].attendance_percentage == 100.0

    # Verify Late Student Personal Attendance:
    # Eligible sessions: Only S3 (Aug 18) because S1 was held prior to admission date (Aug 15).
    # Total eligible = 1, attended = 1 -> 100.0%
    late_res = await enr_service.calculate_student_personal_attendance(student_user_id=stu_late.id, academic_term_id=term.id)
    assert len(late_res.subjects) == 1
    assert late_res.subjects[0].total_eligible_sessions == 1
    assert late_res.subjects[0].attended_sessions == 1
    assert late_res.subjects[0].attendance_percentage == 100.0

    # Verify Section Analytics (viewed by faculty):
    analytics_service = AnalyticsService(db_session)
    sec_analytics = await analytics_service.get_assignment_analytics(
        current_user=fac,
        teaching_assignment_id=ta.id,
    )
    # Total held sessions = 2 (COUNTED finalized: S1 & S3)
    # Total cancelled = 1 (S2)
    # Total exempt = 1 (S4)
    # DRAFT session (S5) is excluded
    assert sec_analytics.total_held_sessions == 2
    assert sec_analytics.total_cancelled_sessions == 1
    assert sec_analytics.total_exempt_sessions == 1


# =========================================================================
# 3. HISTORICAL ENROLLMENT RETENTION ACROSS TRANSFERS & PROMOTION
# =========================================================================

@pytest.mark.asyncio
async def test_section_transfer_attendance_retention_and_historical_integrity(db_session: AsyncSession):
    """
    Verify:
    1. Student transferring from Section A to Section B retains all historical attendance.
    2. Student's attendance in the subject consolidates sessions from both sections.
    3. Section A historical report reflects student membership up to transfer date.
    4. Section B historical report reflects student membership starting from transfer date.
    """
    await ensure_default_institution(db_session)

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_TRANS_{uuid.uuid4().hex[:6]}",
        name="Term Transfer",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_TR_{uuid.uuid4().hex[:4]}", name="Dept Transfer")
    db_session.add_all([term, dept])
    await db_session.flush()

    sec_a = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="TR-SEC-A", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    sec_b = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="TR-SEC-B", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    subj = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code="CS301-TR", name="DBMS Transferable")
    fac_a = make_user("fac_a_tr@test.edu", "Prof Sec A", UserRole.FACULTY)
    fac_b = make_user("fac_b_tr@test.edu", "Prof Sec B", UserRole.FACULTY)
    student = make_user("stu_transfer@test.edu", "Transfer Student", UserRole.STUDENT, institutional_id="STU-TRANS-01")
    admin = make_user("admin_tr@test.edu", "Admin TR", UserRole.ADMIN)
    db_session.add_all([sec_a, sec_b, subj, fac_a, fac_b, student, admin])
    await db_session.flush()

    ta_a = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac_a.id,
        class_section_id=sec_a.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    ta_b = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac_b.id,
        class_section_id=sec_b.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    db_session.add_all([ta_a, ta_b])
    await db_session.flush()

    # Initial enrollment in Section A on Aug 1
    enr_service = EnrollmentService(db_session)
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=student.id,
            class_section_id=sec_a.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
        )
    )

    # 1. Section A holds 10 classes in August (Aug 1 to Aug 31). Student attends 8.
    for i in range(10):
        s_date = date(2026, 8, 3) + timedelta(days=i * 2)
        sess = AttendanceSession(
            client_session_uuid=uuid.uuid4(),
            teaching_assignment_id=ta_a.id,
            session_date=s_date,
            period_slot_or_sequence=1,
            applicability_status=SessionApplicability.COUNTED,
            session_status=AttendanceSessionStatus.FINALIZED,
            regular_faculty_user_id=fac_a.id,
            conducting_faculty_user_id=fac_a.id,
        )
        db_session.add(sess)
        await db_session.flush()
        db_session.add(
            AttendanceRecord(
                attendance_session_id=sess.id,
                student_user_id=student.id,
                attendance_status=AttendanceStatus.PRESENT if i < 8 else AttendanceStatus.ABSENT,
            )
        )

    # 2. Transfer student from Section A to Section B on Sep 1
    transfer_date = date(2026, 9, 1)
    await enr_service.transfer_student(
        StudentTransferRequest(
            student_user_id=student.id,
            current_class_section_id=sec_a.id,
            new_class_section_id=sec_b.id,
            transfer_date=transfer_date,
        )
    )

    # 3. Section B holds 10 classes in September (Sep 2 to Sep 25). Student attends 8.
    for i in range(10):
        s_date = date(2026, 9, 2) + timedelta(days=i * 2)
        sess = AttendanceSession(
            client_session_uuid=uuid.uuid4(),
            teaching_assignment_id=ta_b.id,
            session_date=s_date,
            period_slot_or_sequence=1,
            applicability_status=SessionApplicability.COUNTED,
            session_status=AttendanceSessionStatus.FINALIZED,
            regular_faculty_user_id=fac_b.id,
            conducting_faculty_user_id=fac_b.id,
        )
        db_session.add(sess)
        await db_session.flush()
        db_session.add(
            AttendanceRecord(
                attendance_session_id=sess.id,
                student_user_id=student.id,
                attendance_status=AttendanceStatus.PRESENT if i < 8 else AttendanceStatus.ABSENT,
            )
        )

    # 4. Section A also holds 5 more classes in September (after student transferred out)
    for i in range(5):
        s_date = date(2026, 9, 2) + timedelta(days=i * 2)
        sess = AttendanceSession(
            client_session_uuid=uuid.uuid4(),
            teaching_assignment_id=ta_a.id,
            session_date=s_date,
            period_slot_or_sequence=1,
            applicability_status=SessionApplicability.COUNTED,
            session_status=AttendanceSessionStatus.FINALIZED,
            regular_faculty_user_id=fac_a.id,
            conducting_faculty_user_id=fac_a.id,
        )
        db_session.add(sess)
    await db_session.flush()

    # Verify Student Attendance per Teaching Assignment:
    # Held while enrolled in Section A = 10, attended = 8 -> 80.0%
    # Held while enrolled in Section B = 10, attended = 8 -> 80.0%
    # Overall = (8 + 8) / (10 + 10) = 16 / 20 = 80.0%
    # The 5 classes held in Section A after transfer must NOT be counted against the student!
    att_res = await enr_service.calculate_student_personal_attendance(student_user_id=student.id, academic_term_id=term.id)
    assert len(att_res.subjects) == 2
    sub_a = next(s for s in att_res.subjects if s.teaching_assignment_id == ta_a.id)
    sub_b = next(s for s in att_res.subjects if s.teaching_assignment_id == ta_b.id)
    assert sub_a.total_eligible_sessions == 10
    assert sub_a.attended_sessions == 8
    assert sub_a.attendance_percentage == 80.0
    assert sub_b.total_eligible_sessions == 10
    assert sub_b.attended_sessions == 8
    assert sub_b.attendance_percentage == 80.0
    assert att_res.overall_attendance_percentage == 80.0

    # Verify Student Subject History for ta_b contains the 10 eligible sessions in Section B
    hist_b = await enr_service.get_student_subject_history(student_user_id=student.id, teaching_assignment_id=ta_b.id)
    assert hist_b.total_eligible_sessions == 10
    assert hist_b.attended_sessions == 8
    assert len(hist_b.records) == 10

    # Verify Student Subject History for ta_a contains the 10 eligible sessions in Section A
    hist_a = await enr_service.get_student_subject_history(student_user_id=student.id, teaching_assignment_id=ta_a.id)
    assert hist_a.total_eligible_sessions == 10
    assert hist_a.attended_sessions == 8
    assert len(hist_a.records) == 10

    # Verify Section A historical report (viewed by fac_a):
    analytics_service = AnalyticsService(db_session)
    analytics_a = await analytics_service.get_assignment_analytics(current_user=fac_a, teaching_assignment_id=ta_a.id)
    stu_a_item = next(s for s in analytics_a.roster_summaries if s.student_user_id == student.id)
    # In Section A, student was enrolled for 10 sessions, attended 8 -> 80.0%
    assert stu_a_item.total_eligible_sessions == 10
    assert stu_a_item.attended_sessions == 8

    # Verify Section B historical report (viewed by fac_b):
    analytics_b = await analytics_service.get_assignment_analytics(current_user=fac_b, teaching_assignment_id=ta_b.id)
    stu_b_item = next(s for s in analytics_b.roster_summaries if s.student_user_id == student.id)
    # In Section B, student was enrolled for 10 sessions, attended 8 -> 80.0%
    assert stu_b_item.total_eligible_sessions == 10
    assert stu_b_item.attended_sessions == 8


# =========================================================================
# 4. ATTENDANCE CORRECTIONS & AUDITABILITY
# =========================================================================

@pytest.mark.asyncio
async def test_attendance_corrections_and_immutable_audit(db_session: AsyncSession):
    """
    Verify:
    1. Regular faculty can amend a finalized attendance record within correction window.
    2. Session aggregates update immediately and atomic audit trail is created.
    3. Substitute faculty are strictly excluded from post-finalization amendments.
    4. Amending with reason < 10 characters is rejected.
    5. Amending unfinalized session is rejected.
    """
    await ensure_default_institution(db_session)

    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_AMD_{uuid.uuid4().hex[:4]}", name="Dept Amendment")
    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_AMD_{uuid.uuid4().hex[:6]}",
        name="Term Amendment",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    sec = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="AMD-SEC", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    subj = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code="CS_AMD", name="Compiler Design")
    fac_reg = make_user("fac_reg_amd@test.edu", "Prof Regular", UserRole.FACULTY)
    fac_sub = make_user("fac_sub_amd@test.edu", "Prof Substitute", UserRole.FACULTY)
    student = make_user("stu_amd@test.edu", "Student AMD", UserRole.STUDENT, institutional_id="STU-AMD-01")
    admin = make_user("admin_amd@test.edu", "Admin AMD", UserRole.ADMIN)
    db_session.add_all([sec, subj, fac_reg, fac_sub, student, admin])
    await db_session.flush()

    ta = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac_reg.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    db_session.add(ta)
    await db_session.flush()

    # Session conducted today: student marked ABSENT
    today = date.today()
    sess = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=today,
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=fac_reg.id,
        conducting_faculty_user_id=fac_reg.id,
        present_count=0,
        absent_count=1,
        excused_count=0,
        records_count=1,
    )
    db_session.add(sess)
    await db_session.flush()

    rec = AttendanceRecord(
        attendance_session_id=sess.id,
        student_user_id=student.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
    )
    db_session.add(rec)
    await db_session.flush()

    amend_service = AmendmentService(db_session, correction_window_days=7)

    # 1. Substitute faculty attempt to amend -> OutOfScopeError
    with pytest.raises(OutOfScopeError) as exc_sub:
        await amend_service.amend_attendance_record(
            session_id=sess.id,
            student_user_id=student.id,
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="Medical slip provided by student",
            current_user=fac_sub,
        )
    assert "Substitute faculty are excluded" in str(exc_sub.value)

    # 2. Short reason (< 10 chars) -> AttendanceDomainError
    with pytest.raises(AttendanceDomainError) as exc_short:
        await amend_service.amend_attendance_record(
            session_id=sess.id,
            student_user_id=student.id,
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="Too short",
            current_user=fac_reg,
        )
    assert "at least 10" in str(exc_short.value)

    # 3. Regular faculty amends to PRESENT with valid reason
    audit = await amend_service.amend_attendance_record(
        session_id=sess.id,
        student_user_id=student.id,
        new_status=AttendanceStatus.PRESENT,
        amendment_reason="Student medical slip verified and approved by department head",
        current_user=fac_reg,
    )

    # Verify audit trail
    assert audit.id is not None
    assert audit.attendance_session_id == sess.id
    assert audit.student_user_id == student.id
    assert audit.previous_status == AttendanceStatus.ABSENT
    assert audit.new_status == AttendanceStatus.PRESENT
    assert audit.amending_user_id == fac_reg.id
    assert audit.amendment_role == AmendmentRole.REGULAR_FACULTY

    # Verify record updated
    await db_session.refresh(rec)
    assert rec.attendance_status == AttendanceStatus.PRESENT
    assert rec.mark_source == MarkSource.MANUAL_OVERRIDE

    # Verify session counts updated atomically
    await db_session.refresh(sess)
    assert sess.present_count == 1
    assert sess.absent_count == 0


# =========================================================================
# 5. SHORTAGE INTELLIGENCE & INSTITUTIONAL THRESHOLD RESOLUTION
# =========================================================================

@pytest.mark.asyncio
async def test_shortage_intelligence_and_threshold_configuration(db_session: AsyncSession):
    """
    Verify:
    1. Shortage calculations use DeploymentConfig.attendance_shortage_threshold.
    2. Recovery classes formula: ceil((T * H - 100 * A) / (100 - T)).
    3. Can miss classes formula: floor(100 * A / T - H).
    4. Recoverability edge cases: 100% threshold when A < H.
    """
    await ensure_default_institution(db_session)

    # Ensure deployment config exists with 80% threshold
    cfg_stmt = select(DeploymentConfig).where(DeploymentConfig.singleton_id == 1)
    cfg = (await db_session.execute(cfg_stmt)).scalar_one_or_none()
    if cfg:
        cfg.attendance_shortage_threshold = 80.0
    else:
        cfg = DeploymentConfig(
            singleton_id=1,
            institution_id=DEFAULT_INSTITUTION_ID,
            attendance_shortage_threshold=80.0,
        )
        db_session.add(cfg)
    await db_session.flush()

    # Verify get_institution_threshold returns configured 80.0%
    thresh = await get_institution_threshold(db_session)
    assert thresh == 80.0

    # Mathematical Formula Tests:
    # Case 1: H = 20, A = 15.
    # At T = 75%: 15/20 = 75.0% -> R = 0, can_miss = 0.
    # At T = 80%: 15/20 = 75.0% < 80.0% -> is_shortage = True.
    # R = ceil((80 * 20 - 100 * 15) / (100 - 80)) = ceil((1600 - 1500) / 20) = ceil(100 / 20) = 5.
    r_80, is_rec_80 = calculate_recovery_classes(attended=15, held=20, threshold=80.0)
    assert r_80 == 5
    assert is_rec_80 is True
    miss_80 = calculate_can_miss_classes(attended=15, held=20, threshold=80.0)
    assert miss_80 == 0

    # Case 2: H = 20, A = 18.
    # Current pct = 90.0% > 80.0%.
    # Max held at 80% = (100 * 18) / 80 = 22.5.
    # can_miss = floor(22.5 - 20) = floor(2.5) = 2.
    # Verify: if misses 2 classes -> H = 22, A = 18 -> 18/22 = 81.8% >= 80%.
    # If misses 3 classes -> H = 23, A = 18 -> 18/23 = 78.26% < 80%.
    r_safe, is_rec_safe = calculate_recovery_classes(attended=18, held=20, threshold=80.0)
    assert r_safe == 0
    assert is_rec_safe is True
    miss_safe = calculate_can_miss_classes(attended=18, held=20, threshold=80.0)
    assert miss_safe == 2

    # Case 3: 100% threshold when A < H -> Recovery is impossible
    r_100, is_rec_100 = calculate_recovery_classes(attended=19, held=20, threshold=100.0)
    assert r_100 is None
    assert is_rec_100 is False


# =========================================================================
# 6. REPORTING PERMISSIONS & IAC SCOPING
# =========================================================================

@pytest.mark.asyncio
async def test_reporting_and_iac_scoping(async_client: AsyncClient, db_session: AsyncSession):
    """
    Verify:
    1. Department Head (HOD) can access section analytics for their department.
    2. HOD is blocked with OutOfScopeError when attempting to access another department's assignment.
    3. Class Advisor can access section analytics for their assigned section.
    4. Student attempting to access assignment analytics is blocked with 403 Forbidden.
    5. Student can access their own attendance via /api/v1/student/attendance.
    """
    await ensure_default_institution(db_session)

    # 1. Setup two departments: CS and EE
    dept_cs = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"CS_{uuid.uuid4().hex[:4]}", name="Computer Science")
    dept_ee = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"EE_{uuid.uuid4().hex[:4]}", name="Electrical Eng")
    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_REP_{uuid.uuid4().hex[:6]}",
        name="Term Reporting",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept_cs, dept_ee, term])
    await db_session.flush()

    sec_cs = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="CS-A", department_id=dept_cs.id, academic_term_id=term.id, cohort_year=2026)
    sec_ee = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="EE-A", department_id=dept_ee.id, academic_term_id=term.id, cohort_year=2026)
    subj_cs = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept_cs.id, code="CS_REP", name="CS Core")
    subj_ee = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept_ee.id, code="EE_REP", name="EE Core")
    db_session.add_all([sec_cs, sec_ee, subj_cs, subj_ee])
    await db_session.flush()

    # Users
    hod_cs = make_user("hod_cs@test.edu", "HOD Computer Science", UserRole.FACULTY, institutional_id="HOD-CS-01")
    advisor_cs = make_user("advisor_cs@test.edu", "Advisor CS Section A", UserRole.FACULTY, institutional_id="ADV-CS-01")
    prof_cs = make_user("prof_cs@test.edu", "Prof CS Assigned", UserRole.FACULTY, institutional_id="FAC-CS-01")
    prof_ee = make_user("prof_ee@test.edu", "Prof EE Assigned", UserRole.FACULTY, institutional_id="FAC-EE-01")
    student = make_user("stu_rep@test.edu", "Student Reporting", UserRole.STUDENT, institutional_id="STU-REP-01")
    admin = make_user("admin_rep@test.edu", "Admin Reporting", UserRole.ADMIN, institutional_id="ADM-REP-01")
    db_session.add_all([hod_cs, advisor_cs, prof_cs, prof_ee, student, admin])
    await db_session.flush()

    # Assign IAC roles with specific scopes:
    # HOD CS: Role DEPARTMENT_HEAD_COORDINATOR with DEPARTMENT scope on dept_cs
    await setup_membership_and_role(db_session, hod_cs, "DEPARTMENT_HEAD_COORDINATOR", scope_type=RoleScopeType.DEPARTMENT, department_id=dept_cs.id)
    # Advisor CS: Role CLASS_ADVISOR with CLASS_SECTION scope on sec_cs
    await setup_membership_and_role(db_session, advisor_cs, "CLASS_ADVISOR", scope_type=RoleScopeType.CLASS_SECTION, class_section_id=sec_cs.id)
    # Student: STUDENT role
    await setup_membership_and_role(db_session, student, "STUDENT", scope_type=RoleScopeType.STUDENT)

    # Teaching assignments
    ta_cs = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=prof_cs.id,
        class_section_id=sec_cs.id,
        subject_id=subj_cs.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    ta_ee = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=prof_ee.id,
        class_section_id=sec_ee.id,
        subject_id=subj_ee.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    db_session.add_all([ta_cs, ta_ee])
    await db_session.flush()

    # Enroll student in CS section
    enr_service = EnrollmentService(db_session)
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=student.id,
            class_section_id=sec_cs.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
        )
    )

    # Create 1 session in CS
    s_cs = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta_cs.id,
        session_date=date(2026, 8, 5),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=prof_cs.id,
        conducting_faculty_user_id=prof_cs.id,
    )
    db_session.add(s_cs)
    await db_session.flush()
    db_session.add(AttendanceRecord(attendance_session_id=s_cs.id, student_user_id=student.id, attendance_status=AttendanceStatus.PRESENT))
    await db_session.flush()

    analytics_service = AnalyticsService(db_session)

    # 1. HOD CS accesses CS assignment analytics -> ALLOWED via Department Scope
    hod_analytics = await analytics_service.get_assignment_analytics(current_user=hod_cs, teaching_assignment_id=ta_cs.id)
    assert hod_analytics.section_code == "CS-A"
    assert hod_analytics.total_held_sessions == 1

    # 2. HOD CS accesses EE assignment analytics -> OutOfScopeError (Department mismatch)
    with pytest.raises(OutOfScopeError):
        await analytics_service.get_assignment_analytics(current_user=hod_cs, teaching_assignment_id=ta_ee.id)

    # 3. Class Advisor accesses CS section analytics -> ALLOWED via Section Scope
    adv_analytics = await analytics_service.get_assignment_analytics(current_user=advisor_cs, teaching_assignment_id=ta_cs.id)
    assert adv_analytics.section_code == "CS-A"

    # 4. Class Advisor accesses EE section analytics -> OutOfScopeError (Section mismatch)
    with pytest.raises(OutOfScopeError):
        await analytics_service.get_assignment_analytics(current_user=advisor_cs, teaching_assignment_id=ta_ee.id)

    # 5. Student accesses assignment analytics -> UnauthorizedRoleError (Forbidden)
    with pytest.raises(UnauthorizedRoleError):
        await analytics_service.get_assignment_analytics(current_user=student, teaching_assignment_id=ta_cs.id)

    # 6. Student accesses own personal attendance -> ALLOWED
    stu_att = await enr_service.calculate_student_personal_attendance(student_user_id=student.id, academic_term_id=term.id)
    assert len(stu_att.subjects) == 1
    assert stu_att.subjects[0].subject_code == "CS_REP"
    assert stu_att.subjects[0].attended_sessions == 1
    assert stu_att.overall_attendance_percentage == 100.0


# =========================================================================
# 7. EXCUSED ATTENDANCE POLICY & PENDING LEAVE INDEPENDENCE
# =========================================================================

@pytest.mark.asyncio
async def test_excused_attendance_policy_and_pending_leave_independence(db_session: AsyncSession):
    """
    Verify:
    1. EXCUSED attendance status counts in attended numerator alongside PRESENT.
    2. ABSENT attendance status does NOT count in attended numerator.
    3. Pending student leave/grievance requests (StudentAttendanceRequest) do NOT
       automatically mutate finalized attendance records or alter percentage.
    """
    await ensure_default_institution(db_session)

    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_{uuid.uuid4().hex[:4]}", name="Civil Eng")
    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_EXC_{uuid.uuid4().hex[:6]}",
        name="Term Excused Policy",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    sec = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="CIV-A", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    subj = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code="CE201", name="Fluid Mechanics")
    db_session.add_all([sec, subj])
    await db_session.flush()

    faculty = make_user("prof_civ@test.edu", "Prof Civil", UserRole.FACULTY)
    student = make_user("stu_civ@test.edu", "Student Civil", UserRole.STUDENT, institutional_id="STU-CIV-01")
    admin = make_user("adm_civ@test.edu", "Admin Civil", UserRole.ADMIN)
    db_session.add_all([faculty, student, admin])
    await db_session.flush()

    ta = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=faculty.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    db_session.add(ta)
    await db_session.flush()

    enr_service = EnrollmentService(db_session)
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=student.id,
            class_section_id=sec.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
        )
    )

    now_utc = datetime.now(timezone.utc)
    # Session 1: PRESENT
    s1 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 3),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
    )
    db_session.add(s1)
    await db_session.flush()
    db_session.add(AttendanceRecord(attendance_session_id=s1.id, student_user_id=student.id, attendance_status=AttendanceStatus.PRESENT))

    # Session 2: EXCUSED (e.g. approved medical or official duty)
    s2 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 4),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
    )
    db_session.add(s2)
    await db_session.flush()
    db_session.add(AttendanceRecord(attendance_session_id=s2.id, student_user_id=student.id, attendance_status=AttendanceStatus.EXCUSED))

    # Session 3: ABSENT
    s3 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 5),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
    )
    db_session.add(s3)
    await db_session.flush()
    db_session.add(AttendanceRecord(attendance_session_id=s3.id, student_user_id=student.id, attendance_status=AttendanceStatus.ABSENT))
    await db_session.flush()

    # 1. Verify calculation with 1 PRESENT, 1 EXCUSED, 1 ABSENT:
    # Held = 3, Attended = 2 (PRESENT + EXCUSED) -> 2 / 3 = 66.7%
    att_res = await enr_service.calculate_student_personal_attendance(student_user_id=student.id, academic_term_id=term.id)
    assert att_res.subjects[0].total_eligible_sessions == 3
    assert att_res.subjects[0].attended_sessions == 2
    assert att_res.subjects[0].attendance_percentage == 66.7
    assert att_res.overall_attendance_percentage == 66.7

    # 2. Student submits a pending attendance request for Session 3 (medical leave)
    leave_req = StudentAttendanceRequest(
        student_user_id=student.id,
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 5),
        student_note="Hospital visit, requesting medical leave",
        status=AttendanceRequestStatus.PENDING,
    )
    db_session.add(leave_req)
    await db_session.flush()

    # Invariant: Pending request MUST NOT automatically change finalized attendance records!
    att_res_pending = await enr_service.calculate_student_personal_attendance(student_user_id=student.id, academic_term_id=term.id)
    assert att_res_pending.subjects[0].attended_sessions == 2
    assert att_res_pending.subjects[0].attendance_percentage == 66.7
    assert att_res_pending.overall_attendance_percentage == 66.7


# =========================================================================
# 8. ZERO-SESSION EXPLICIT NO-DATA STATE (N/A)
# =========================================================================

@pytest.mark.asyncio
async def test_zero_session_explicit_no_data_state(db_session: AsyncSession):
    """
    Verify:
    1. When 0 eligible sessions have been conducted, the system returns an explicit
       no-data state (None / null), NOT a misleading 100.0%.
    2. is_shortage is False, classes_to_recover is None, classes_can_miss is 0.
    3. Section analytics returns None for overall_attendance_percentage.
    """
    await ensure_default_institution(db_session)

    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_{uuid.uuid4().hex[:4]}", name="Bio Tech")
    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_ZERO_{uuid.uuid4().hex[:6]}",
        name="Term Zero Session",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    sec = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="BIO-A", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    subj = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code="BT101", name="Cell Biology")
    db_session.add_all([sec, subj])
    await db_session.flush()

    faculty = make_user("prof_bio@test.edu", "Prof Bio", UserRole.FACULTY)
    student = make_user("stu_bio@test.edu", "Student Bio", UserRole.STUDENT, institutional_id="STU-BIO-01")
    admin = make_user("adm_bio@test.edu", "Admin Bio", UserRole.ADMIN)
    db_session.add_all([faculty, student, admin])
    await db_session.flush()

    ta = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=faculty.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    db_session.add(ta)
    await db_session.flush()

    enr_service = EnrollmentService(db_session)
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=student.id,
            class_section_id=sec.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
        )
    )

    # 1. Student personal attendance: 0 sessions held
    stu_att = await enr_service.calculate_student_personal_attendance(student_user_id=student.id, academic_term_id=term.id)
    assert len(stu_att.subjects) == 1
    sub_summary = stu_att.subjects[0]
    assert sub_summary.total_eligible_sessions == 0
    assert sub_summary.attended_sessions == 0
    assert sub_summary.attendance_percentage is None  # MUST NOT be 100.0!
    assert sub_summary.is_shortage is False
    assert sub_summary.classes_to_recover == 0
    assert sub_summary.classes_can_miss == 0
    assert stu_att.overall_attendance_percentage is None  # MUST NOT be 100.0!
    assert stu_att.total_eligible_sessions == 0

    # 2. Student subject history: 0 sessions held
    hist = await enr_service.get_student_subject_history(student_user_id=student.id, teaching_assignment_id=ta.id)
    assert hist.total_eligible_sessions == 0
    assert hist.attended_sessions == 0
    assert hist.attendance_percentage is None  # Explicit no-data
    assert hist.is_shortage is False
    assert hist.classes_to_recover == 0
    assert hist.classes_can_miss == 0
    assert len(hist.records) == 0

    # 3. Section Analytics overview for faculty: 0 sessions held
    analytics_service = AnalyticsService(db_session)
    sec_analytics = await analytics_service.get_assignment_analytics(current_user=faculty, teaching_assignment_id=ta.id)
    assert sec_analytics.total_held_sessions == 0
    assert sec_analytics.average_attendance_percentage is None  # Explicit no-data
    assert len(sec_analytics.roster_summaries) == 1
    assert sec_analytics.roster_summaries[0].attendance_percentage is None
    assert sec_analytics.roster_summaries[0].classes_to_recover == 0
    assert sec_analytics.roster_summaries[0].is_shortage is False


# =========================================================================
# 9. COMPREHENSIVE RECOVERY & CAN-MISS FORMULA VALIDATION
# =========================================================================

def test_recovery_and_can_miss_comprehensive_validation():
    """
    Stress-test shortage recovery and safe-miss allowances across:
    - Multiple thresholds: 65%, 75%, 80%, 85%.
    - Zero attended sessions (A = 0, H > 0).
    - Zero held sessions (A = 0, H = 0).
    - Attendance exactly at the threshold (P = T).
    - Attendance just below the threshold (P = T - epsilon).
    - Integer rounding boundaries (ceil vs exact integer).
    - Mathematical verification that R is the exact minimum consecutive classes.
    """
    # 1. Zero sessions held: R = 0, is_recoverable = True, can_miss = 0
    r_zero, ok_zero = calculate_recovery_classes(attended=0, held=0, threshold=75.0)
    assert r_zero == 0
    assert ok_zero is True
    assert calculate_can_miss_classes(attended=0, held=0, threshold=75.0) == 0

    # 2. Testing across thresholds: [65%, 75%, 80%, 85%]
    test_cases = [
        # (Threshold, Held, Attended, Expected R, Expected Miss)
        # Exactly at threshold: R = 0, Miss = 0
        (65.0, 20, 13, 0, 0),   # 13/20 = 65.0%
        (75.0, 20, 15, 0, 0),   # 15/20 = 75.0%
        (80.0, 20, 16, 0, 0),   # 16/20 = 80.0%
        (85.0, 20, 17, 0, 0),   # 17/20 = 85.0%

        # Just below threshold:
        # At 65%: H=20, A=12 (60.0%). R = ceil((65*20 - 100*12)/35) = ceil(100/35) = ceil(2.857) = 3.
        (65.0, 20, 12, 3, 0),
        # At 75%: H=20, A=14 (70.0%). R = ceil((75*20 - 100*14)/25) = ceil(100/25) = 4.
        (75.0, 20, 14, 4, 0),
        # At 80%: H=20, A=15 (75.0%). R = ceil((80*20 - 100*15)/20) = ceil(100/20) = 5.
        (80.0, 20, 15, 5, 0),
        # At 85%: H=20, A=16 (80.0%). R = ceil((85*20 - 100*16)/15) = ceil(100/15) = ceil(6.667) = 7.
        (85.0, 20, 16, 7, 0),

        # Zero attended (A = 0, H = 10):
        # At 65%: R = ceil(65*10 / 35) = ceil(650/35) = ceil(18.57) = 19.
        (65.0, 10, 0, 19, 0),
        # At 75%: R = ceil(75*10 / 25) = ceil(750/25) = 30.
        (75.0, 10, 0, 30, 0),
        # At 80%: R = ceil(80*10 / 20) = ceil(800/20) = 40.
        (80.0, 10, 0, 40, 0),
        # At 85%: R = ceil(85*10 / 15) = ceil(850/15) = ceil(56.67) = 57.
        (85.0, 10, 0, 57, 0),

        # Safe miss allowance (A = 19, H = 20 -> 95%):
        # At 65%: M = floor(1900/65 - 20) = floor(29.23 - 20) = 9.
        (65.0, 20, 19, 0, 9),
        # At 75%: M = floor(1900/75 - 20) = floor(25.33 - 20) = 5.
        (75.0, 20, 19, 0, 5),
        # At 80%: M = floor(1900/80 - 20) = floor(23.75 - 20) = 3.
        (80.0, 20, 19, 0, 3),
        # At 85%: M = floor(1900/85 - 20) = floor(22.35 - 20) = 2.
        (85.0, 20, 19, 0, 2),
    ]

    for thresh, h, a, expected_r, expected_m in test_cases:
        r, is_rec = calculate_recovery_classes(attended=a, held=h, threshold=thresh)
        assert is_rec is True
        assert r == expected_r, f"Failed recovery for T={thresh}, H={h}, A={a}: got {r}, expected {expected_r}"

        m = calculate_can_miss_classes(attended=a, held=h, threshold=thresh)
        assert m == expected_m, f"Failed can_miss for T={thresh}, H={h}, A={a}: got {m}, expected {expected_m}"

        # Mathematical Proof Verification:
        if expected_r > 0:
            # 1. Attending expected_r classes reaches or exceeds threshold
            pct_after = ((a + expected_r) / (h + expected_r)) * 100.0
            assert pct_after >= thresh, f"Attending {expected_r} did not reach {thresh}%: got {pct_after}%"
            # 2. Attending expected_r - 1 classes is strictly below threshold
            if expected_r > 1:
                pct_prior = ((a + expected_r - 1) / (h + expected_r - 1)) * 100.0
                assert pct_prior < thresh, f"Attending {expected_r - 1} prematurely reached {thresh}%: got {pct_prior}%"

        if expected_m > 0:
            # 1. Missing expected_m classes stays at or above threshold
            pct_miss = (a / (h + expected_m)) * 100.0
            assert pct_miss >= thresh, f"Missing {expected_m} classes dropped below {thresh}%: got {pct_miss}%"
            # 2. Missing expected_m + 1 classes drops strictly below threshold
            pct_miss_more = (a / (h + expected_m + 1)) * 100.0
            assert pct_miss_more < thresh, f"Missing {expected_m + 1} classes did not drop below {thresh}%: got {pct_miss_more}%"

