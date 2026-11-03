"""
Unit tests for AnalyticsService calculations and invariants:
- Recovery classes formula: R = ceil((T*H - 100*A) / (100 - T))
- Allowed future absences formula: M = floor(100*A / T - H)
- Zero held sessions, threshold boundaries (100%, 0%), and rounding behavior
- Denominator exclusion for CANCELLED and EXEMPT sessions
- Date-bounded eligibility (late admission, transfers)
- Consecutive absences reverse-chronological run calculation and non-ABSENT stop condition
"""

from datetime import date, datetime, timedelta, timezone
import uuid
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

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
from src.services.analytics_service import (
    AnalyticsService,
    calculate_can_miss_classes,
    calculate_recovery_classes,
)


# ===========================================================================
# 1. Mathematical Formulas Unit Tests
# ===========================================================================


def test_recovery_classes_formula_basic():
    """Verify recovery calculation when attendance is strictly below threshold."""
    # Held = 38, Attended = 22 -> pct = 57.89% < 75%
    # R = ceil((75 * 38 - 100 * 22) / (100 - 75)) = ceil((2850 - 2200) / 25) = ceil(650 / 25) = 26
    r, ok = calculate_recovery_classes(attended=22, held=38, threshold=75.0)
    assert r == 26
    assert ok is True

    # Held = 38, Attended = 27 -> pct = 71.05% < 75%
    # R = ceil((75 * 38 - 100 * 27) / 25) = ceil((2850 - 2700) / 25) = ceil(150 / 25) = 6
    r2, ok2 = calculate_recovery_classes(attended=27, held=38, threshold=75.0)
    assert r2 == 6
    assert ok2 is True


def test_recovery_classes_formula_at_or_above_threshold():
    """When attendance is >= threshold, recovery classes must be 0 and recoverable."""
    # Held = 38, Attended = 36 (94.7% >= 75%)
    r, ok = calculate_recovery_classes(attended=36, held=38, threshold=75.0)
    assert r == 0
    assert ok is True

    # Exactly at threshold: Held = 40, Attended = 30 (75.0%)
    r2, ok2 = calculate_recovery_classes(attended=30, held=40, threshold=75.0)
    assert r2 == 0
    assert ok2 is True


def test_recovery_classes_zero_sessions_and_boundaries():
    """Zero held classes or extreme thresholds: 0%, 75%, 99%, 100%."""
    # Zero sessions held: baseline 0, recoverable
    r, ok = calculate_recovery_classes(attended=0, held=0, threshold=75.0)
    assert r == 0
    assert ok is True

    # 100% threshold: once a class is missed (A < H), 100% is mathematically unachievable
    # Must NOT return -1; must return (None, False)
    r_unrec, ok_unrec = calculate_recovery_classes(attended=9, held=10, threshold=100.0)
    assert r_unrec is None
    assert ok_unrec is False

    # 100% threshold: 0 classes missed -> (0, True)
    r_perf, ok_perf = calculate_recovery_classes(attended=10, held=10, threshold=100.0)
    assert r_perf == 0
    assert ok_perf is True

    # 99% threshold: recoverable but requires high streak
    # Held = 10, Attended = 9 -> pct = 90% < 99%
    # R = ceil((99 * 10 - 100 * 9) / (100 - 99)) = ceil((990 - 900) / 1) = 90
    r_99, ok_99 = calculate_recovery_classes(attended=9, held=10, threshold=99.0)
    assert r_99 == 90
    assert ok_99 is True

    # 0% threshold: attendance is always >= 0% -> 0
    r_0, ok_0 = calculate_recovery_classes(attended=0, held=5, threshold=0.0)
    assert r_0 == 0
    assert ok_0 is True


def test_allowed_misses_formula():
    """Verify allowed future absences when attendance is strictly above threshold."""
    # Held = 38, Attended = 36 (94.7% > 75%)
    # M = floor(100 * 36 / 75 - 38) = floor(48.0 - 38) = 10
    m = calculate_can_miss_classes(attended=36, held=38, threshold=75.0)
    assert m == 10

    # Exactly at threshold: Held = 40, Attended = 30 (75.0%) -> cannot miss any
    assert calculate_can_miss_classes(attended=30, held=40, threshold=75.0) == 0

    # Below threshold: cannot miss any
    assert calculate_can_miss_classes(attended=22, held=38, threshold=75.0) == 0

    # Zero held: 0
    assert calculate_can_miss_classes(attended=0, held=0, threshold=75.0) == 0


# ===========================================================================
# 2. Service Denominator and Eligibility Unit Tests
# ===========================================================================


@pytest.fixture
async def analytics_test_data(db_session: AsyncSession) -> dict:
    """Setup faculty, student, academic context, and assignment."""
    admin = User(
        institutional_id="ADM-ANALYTICS-01",
        email="admin_analytics@institution.edu",
        password_hash="fake",
        full_name="Admin Director",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    faculty = User(
        institutional_id="FAC-ANALYTICS-01",
        email="faculty_analytics@institution.edu",
        password_hash="fake",
        full_name="Dr. Analytics Prof",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student_a = User(
        institutional_id="STU-ANALYTICS-01",
        email="student_a@institution.edu",
        password_hash="fake",
        full_name="Student Alpha",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    student_b = User(
        institutional_id="STU-ANALYTICS-02",
        email="student_b@institution.edu",
        password_hash="fake",
        full_name="Student Beta (Late Admission)",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, faculty, student_a, student_b])
    await db_session.flush()

    dept = Department(code="CSE-ANA", name="Computer Science Analytics")
    term = AcademicTerm(
        code="2026-FALL-ANA",
        name="Fall 2026 Analytics",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS310", name="Database Systems", department_id=dept.id, credits=3)
    section = ClassSection(
        section_code="CSE-3ANA",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2024,
    )
    db_session.add_all([subject, section])
    await db_session.flush()

    assignment = TeachingAssignment(
        faculty_user_id=faculty.id,
        class_section_id=section.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add(assignment)
    await db_session.flush()

    # Student A: Enrolled from term start (2026-08-01)
    enr_a = StudentEnrollment(
        student_user_id=student_a.id,
        class_section_id=section.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 1),
        effective_end_date=None,
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    # Student B: Late admission (enrolled 2026-08-15)
    enr_b = StudentEnrollment(
        student_user_id=student_b.id,
        class_section_id=section.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 15),
        effective_end_date=None,
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add_all([enr_a, enr_b])
    await db_session.flush()

    return {
        "admin": admin,
        "faculty": faculty,
        "student_a": student_a,
        "student_b": student_b,
        "assignment": assignment,
        "enr_a": enr_a,
        "enr_b": enr_b,
    }


@pytest.mark.asyncio
async def test_analytics_denominator_and_late_admission(
    db_session: AsyncSession, analytics_test_data: dict
):
    """
    Test that CANCELLED and EXEMPT sessions are excluded from denominator,
    and late admissions exclude prior sessions.
    """
    ctx = analytics_test_data
    ta = ctx["assignment"]
    student_a = ctx["student_a"]
    student_b = ctx["student_b"]

    # Session 1: 2026-08-05 (COUNTED) -> before Student B enrolled
    s1 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 5),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=datetime.now(timezone.utc),
        regular_faculty_user_id=ctx["faculty"].id,
        conducting_faculty_user_id=ctx["faculty"].id,
    )
    # Session 2: 2026-08-10 (CANCELLED) -> holiday
    s2 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 10),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.CANCELLED,
        status_reason="Institutional Holiday",
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=datetime.now(timezone.utc),
        regular_faculty_user_id=ctx["faculty"].id,
        conducting_faculty_user_id=ctx["faculty"].id,
    )
    # Session 3: 2026-08-18 (COUNTED) -> both enrolled
    s3 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 18),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=datetime.now(timezone.utc),
        regular_faculty_user_id=ctx["faculty"].id,
        conducting_faculty_user_id=ctx["faculty"].id,
    )
    # Session 4: 2026-08-20 (EXEMPT) -> college symposium
    s4 = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 20),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.EXEMPT,
        status_reason="Technical Symposium",
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=datetime.now(timezone.utc),
        regular_faculty_user_id=ctx["faculty"].id,
        conducting_faculty_user_id=ctx["faculty"].id,
    )
    db_session.add_all([s1, s2, s3, s4])
    await db_session.flush()

    # Records:
    # S1: Student A is PRESENT
    r1_a = AttendanceRecord(
        attendance_session_id=s1.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.PRESENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=datetime.now(timezone.utc),
    )
    # S3: Student A is ABSENT, Student B is PRESENT
    r3_a = AttendanceRecord(
        attendance_session_id=s3.id,
        student_user_id=student_a.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=datetime.now(timezone.utc),
    )
    r3_b = AttendanceRecord(
        attendance_session_id=s3.id,
        student_user_id=student_b.id,
        attendance_status=AttendanceStatus.PRESENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=datetime.now(timezone.utc),
    )
    db_session.add_all([r1_a, r3_a, r3_b])
    await db_session.flush()

    service = AnalyticsService(db_session)
    analytics = await service.get_assignment_analytics(
        current_user=ctx["faculty"],
        teaching_assignment_id=ta.id,
        threshold=75.0,
    )

    # Invariants:
    # Total held counted sessions = 2 (s1, s3)
    assert analytics.total_held_sessions == 2
    # Cancelled = 1, Exempt = 1
    assert analytics.total_cancelled_sessions == 1
    assert analytics.total_exempt_sessions == 1

    # Student A: eligible = 2, attended = 1 -> 50.0%
    stu_a_item = next(s for s in analytics.roster_summaries if s.student_user_id == student_a.id)
    assert stu_a_item.total_eligible_sessions == 2
    assert stu_a_item.attended_sessions == 1
    assert stu_a_item.attendance_percentage == 50.0
    assert stu_a_item.is_shortage is True
    # R = ceil((75 * 2 - 100) / 25) = ceil(50 / 25) = 2
    assert stu_a_item.classes_to_recover == 2
    assert stu_a_item.is_recoverable is True

    # Student B: eligible = 1 (only s3, since s1 is prior to effective_start_date 2026-08-15)
    # attended = 1 -> 100.0%
    stu_b_item = next(s for s in analytics.roster_summaries if s.student_user_id == student_b.id)
    assert stu_b_item.total_eligible_sessions == 1
    assert stu_b_item.attended_sessions == 1
    assert stu_b_item.attendance_percentage == 100.0
    assert stu_b_item.is_shortage is False
    assert stu_b_item.classes_to_recover == 0
    assert stu_b_item.is_recoverable is True


@pytest.mark.asyncio
async def test_analytics_zero_sessions_missing_data_state(
    db_session: AsyncSession, analytics_test_data: dict
):
    """
    When zero eligible sessions have been held, attendance percentage must be None (not 100%),
    preventing cohorts with no sessions from being falsely labelled as healthy.
    """
    ctx = analytics_test_data
    ta = ctx["assignment"]
    service = AnalyticsService(db_session)

    analytics = await service.get_assignment_analytics(
        current_user=ctx["faculty"],
        teaching_assignment_id=ta.id,
        threshold=75.0,
    )

    assert analytics.total_held_sessions == 0
    assert analytics.average_attendance_percentage is None
    assert analytics.shortage_count == 0
    for stu in analytics.roster_summaries:
        assert stu.total_eligible_sessions == 0
        assert stu.attendance_percentage is None
        assert stu.classes_to_recover == 0
        assert stu.is_recoverable is True
        assert stu.is_shortage is False


@pytest.mark.asyncio
async def test_analytics_consecutive_absences_and_excused_stop(
    db_session: AsyncSession, analytics_test_data: dict
):
    """
    Test consecutive absences calculation:
    - Reverse chronological order run.
    - Stopping immediately on non-ABSENT (PRESENT or EXCUSED).
    """
    ctx = analytics_test_data
    ta = ctx["assignment"]
    student = ctx["student_a"]

    # Create 4 consecutive dates:
    # Date 1 (Sep 1): PRESENT
    # Date 2 (Sep 2): EXCUSED
    # Date 3 (Sep 3): ABSENT
    # Date 4 (Sep 4): ABSENT
    # Run should equal 2 (Sep 4 and Sep 3), stopped by Sep 2 (EXCUSED).
    dates = [date(2026, 9, 1), date(2026, 9, 2), date(2026, 9, 3), date(2026, 9, 4)]
    statuses = [
        AttendanceStatus.PRESENT,
        AttendanceStatus.EXCUSED,
        AttendanceStatus.ABSENT,
        AttendanceStatus.ABSENT,
    ]

    for d, st in zip(dates, statuses):
        sess = AttendanceSession(
            client_session_uuid=uuid.uuid4(),
            teaching_assignment_id=ta.id,
            session_date=d,
            period_slot_or_sequence=1,
            applicability_status=SessionApplicability.COUNTED,
            session_status=AttendanceSessionStatus.FINALIZED,
            finalized_at=datetime.now(timezone.utc),
            regular_faculty_user_id=ctx["faculty"].id,
            conducting_faculty_user_id=ctx["faculty"].id,
        )
        db_session.add(sess)
        await db_session.flush()

        rec = AttendanceRecord(
            attendance_session_id=sess.id,
            student_user_id=student.id,
            attendance_status=st,
            mark_source=MarkSource.MANUAL_MARK,
            recorded_at=datetime.now(timezone.utc),
        )
        db_session.add(rec)
        await db_session.flush()

    service = AnalyticsService(db_session)
    run = await service.get_consecutive_absences_for_student(
        student_user_id=student.id,
        teaching_assignment_id=ta.id,
        effective_start_date=ctx["enr_a"].effective_start_date,
    )
    # Must be 2 (Sep 4, Sep 3), stopped by Sep 2 (EXCUSED)
    assert run == 2
