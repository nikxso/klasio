from datetime import date, datetime, timedelta, timezone
import uuid
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import (
    AmendmentWindowExpiredError,
    AttendanceDomainError,
    EntityNotFoundError,
    OutOfScopeError,
    UnauthorizedRoleError,
)
from src.core.security import get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.attendance import (
    AmendmentRole,
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
)
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import AccountStatus, User, UserRole
from src.services.amendment_service import AmendmentService


@pytest.fixture
async def amendment_unit_fixture(db_session: AsyncSession):
    dept = Department(code="CSE-AMD-UNIT", name="Computer Science Dept")
    term = AcademicTerm(
        code="2026-FALL-AMD-U",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS301-AU", name="Algorithms", department_id=dept.id, credits=3)
    section = ClassSection(section_code="CSE-3A-AU", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    db_session.add_all([subject, section])
    await db_session.flush()

    # Users: Regular Faculty, Substitute Faculty, Admin, Student
    reg_faculty = User(
        institutional_id="FAC-AMD-U-REG",
        email="fac_reg_u@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Regular Assigned",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    sub_faculty = User(
        institutional_id="FAC-AMD-U-SUB",
        email="fac_sub_u@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Substitute",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    admin_user = User(
        institutional_id="ADM-AMD-U",
        email="admin_u@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Admin Director",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    student_user = User(
        institutional_id="STU-AMD-U-01",
        email="stu_u_01@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Student Test",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([reg_faculty, sub_faculty, admin_user, student_user])
    await db_session.flush()

    # Teaching Assignment
    assignment = TeachingAssignment(
        class_section_id=section.id,
        subject_id=subject.id,
        faculty_user_id=reg_faculty.id,
        academic_term_id=term.id,
        created_by_user_id=admin_user.id,
        is_active=True,
    )
    # Enrollment
    enrollment = StudentEnrollment(
        student_user_id=student_user.id,
        class_section_id=section.id,
        academic_term_id=term.id,
        enrollment_status=EnrollmentStatus.ACTIVE,
        effective_start_date=date(2026, 8, 1),
    )
    db_session.add_all([assignment, enrollment])
    await db_session.flush()

    # Finalized session conducted by sub_faculty under delegation
    session_date = date(2026, 10, 1)
    now_tz = datetime.now(timezone.utc)
    session = AttendanceSession(
        id=uuid.uuid4(),
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=assignment.id,
        session_date=session_date,
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        regular_faculty_user_id=reg_faculty.id,
        conducting_faculty_user_id=sub_faculty.id,
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
        student_user_id=student_user.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now_tz,
    )
    db_session.add_all([session, record])
    await db_session.flush()

    return {
        "reg_faculty": reg_faculty,
        "sub_faculty": sub_faculty,
        "admin": admin_user,
        "student": student_user,
        "assignment": assignment,
        "session": session,
        "record": record,
        "session_date": session_date,
    }


@pytest.mark.asyncio
async def test_configurable_correction_window_settings(db_session: AsyncSession):
    """T068: Unit test verifying default institutional window and custom window parameter."""
    service_default = AmendmentService(db_session)
    assert service_default.correction_window_days == 7

    service_custom = AmendmentService(db_session, correction_window_days=14)
    assert service_custom.correction_window_days == 14


@pytest.mark.asyncio
async def test_regular_faculty_amendment_within_window(
    db_session: AsyncSession, amendment_unit_fixture: dict
):
    """
    T068: Assigned regular faculty amends record within 7-day window:
    - Succeeds with amendment_role == REGULAR_FACULTY
    - Status transitions ABSENT -> PRESENT
    - Mark source set to MANUAL_OVERRIDE
    - Session counts updated (present_count=1, absent_count=0)
    """
    ctx = amendment_unit_fixture
    service = AmendmentService(db_session, correction_window_days=7)

    # Day 4 after session
    eval_date = ctx["session_date"] + timedelta(days=4)

    audit = await service.amend_attendance_record(
        session_id=ctx["session"].id,
        student_user_id=ctx["student"].id,
        new_status=AttendanceStatus.PRESENT,
        amendment_reason="Medical certificate verified by department",
        current_user=ctx["reg_faculty"],
        eval_date=eval_date,
    )

    assert audit.amendment_role == AmendmentRole.REGULAR_FACULTY
    assert audit.previous_status == AttendanceStatus.ABSENT
    assert audit.new_status == AttendanceStatus.PRESENT
    assert audit.amending_user_id == ctx["reg_faculty"].id

    # Verify record updated
    assert ctx["record"].attendance_status == AttendanceStatus.PRESENT
    assert ctx["record"].mark_source == MarkSource.MANUAL_OVERRIDE

    # Verify session counts updated
    assert ctx["session"].present_count == 1
    assert ctx["session"].absent_count == 0


@pytest.mark.asyncio
async def test_regular_faculty_amendment_beyond_window_rejected(
    db_session: AsyncSession, amendment_unit_fixture: dict
):
    """
    T068: Assigned regular faculty attempts amendment beyond window (e.g. Day 10 > 7 days):
    - Raises AmendmentWindowExpiredError
    - Record status remains unchanged
    """
    ctx = amendment_unit_fixture
    service = AmendmentService(db_session, correction_window_days=7)

    # Day 10 after session (elapsed 10 > window 7)
    eval_date = ctx["session_date"] + timedelta(days=10)

    with pytest.raises(AmendmentWindowExpiredError) as exc_info:
        await service.amend_attendance_record(
            session_id=ctx["session"].id,
            student_user_id=ctx["student"].id,
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="Late correction request from student",
            current_user=ctx["reg_faculty"],
            eval_date=eval_date,
        )

    assert "Correction window of 7 days has expired" in str(exc_info.value.message)
    assert ctx["record"].attendance_status == AttendanceStatus.ABSENT


@pytest.mark.asyncio
async def test_substitute_faculty_strictly_excluded(
    db_session: AsyncSession, amendment_unit_fixture: dict
):
    """
    T068: Substitute faculty who conducted the session under delegation attempts
    post-finalization amendment:
    - Raises OutOfScopeError
    - Excluded from post-finalization authority per FR-027
    """
    ctx = amendment_unit_fixture
    service = AmendmentService(db_session, correction_window_days=7)

    # Even on Day 1 (within window), substitute faculty is strictly excluded
    eval_date = ctx["session_date"] + timedelta(days=1)

    with pytest.raises(OutOfScopeError) as exc_info:
        await service.amend_attendance_record(
            session_id=ctx["session"].id,
            student_user_id=ctx["student"].id,
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="Substitute faculty attempting post-finalization correction",
            current_user=ctx["sub_faculty"],
            eval_date=eval_date,
        )

    assert "Substitute faculty are excluded" in str(exc_info.value.message)


@pytest.mark.asyncio
async def test_admin_override_inside_and_beyond_window(
    db_session: AsyncSession, amendment_unit_fixture: dict
):
    """
    T068: Institutional Administrator performs amendment:
    - Allowed beyond window (e.g. Day 45)
    - amendment_role set to ADMIN
    """
    ctx = amendment_unit_fixture
    service = AmendmentService(db_session, correction_window_days=7)

    eval_date = ctx["session_date"] + timedelta(days=45)

    audit = await service.amend_attendance_record(
        session_id=ctx["session"].id,
        student_user_id=ctx["student"].id,
        new_status=AttendanceStatus.EXCUSED,
        amendment_reason="HOD and Dean administrative approval #789",
        current_user=ctx["admin"],
        eval_date=eval_date,
    )

    assert audit.amendment_role == AmendmentRole.ADMIN
    assert audit.new_status == AttendanceStatus.EXCUSED
    assert ctx["record"].attendance_status == AttendanceStatus.EXCUSED
    assert ctx["session"].excused_count == 1
    assert ctx["session"].absent_count == 0


@pytest.mark.asyncio
async def test_amendment_invariants_validation(
    db_session: AsyncSession, amendment_unit_fixture: dict
):
    """
    T068: Service validation invariants:
    - Status unchanged -> AttendanceDomainError
    - Reason length < 10 -> AttendanceDomainError
    - Unfinalized session -> AttendanceDomainError
    - Unknown student or session -> EntityNotFoundError
    - Student user role -> UnauthorizedRoleError
    """
    ctx = amendment_unit_fixture
    service = AmendmentService(db_session, correction_window_days=7)
    eval_date = ctx["session_date"] + timedelta(days=2)

    # 1. Identical status
    with pytest.raises(AttendanceDomainError) as exc:
        await service.amend_attendance_record(
            session_id=ctx["session"].id,
            student_user_id=ctx["student"].id,
            new_status=AttendanceStatus.ABSENT,
            amendment_reason="Valid reason but identical status",
            current_user=ctx["reg_faculty"],
            eval_date=eval_date,
        )
    assert "must change attendance status" in str(exc.value.message)

    # 2. Reason too short (< 10 non-whitespace chars)
    with pytest.raises(AttendanceDomainError) as exc:
        await service.amend_attendance_record(
            session_id=ctx["session"].id,
            student_user_id=ctx["student"].id,
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="short",
            current_user=ctx["reg_faculty"],
            eval_date=eval_date,
        )
    assert "at least 10 non-whitespace characters" in str(exc.value.message)

    # 3. Unfinalized session
    ctx["session"].session_status = AttendanceSessionStatus.DRAFT
    with pytest.raises(AttendanceDomainError) as exc:
        await service.amend_attendance_record(
            session_id=ctx["session"].id,
            student_user_id=ctx["student"].id,
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="Valid amendment reason here",
            current_user=ctx["reg_faculty"],
            eval_date=eval_date,
        )
    assert "unfinalized" in str(exc.value.message)
    ctx["session"].session_status = AttendanceSessionStatus.FINALIZED

    # 4. Unknown session
    with pytest.raises(EntityNotFoundError):
        await service.amend_attendance_record(
            session_id=uuid.uuid4(),
            student_user_id=ctx["student"].id,
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="Valid amendment reason here",
            current_user=ctx["reg_faculty"],
            eval_date=eval_date,
        )

    # 5. Unknown student
    with pytest.raises(EntityNotFoundError):
        await service.amend_attendance_record(
            session_id=ctx["session"].id,
            student_user_id=uuid.uuid4(),
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="Valid amendment reason here",
            current_user=ctx["reg_faculty"],
            eval_date=eval_date,
        )

    # 6. Student user attempting amendment
    with pytest.raises(UnauthorizedRoleError):
        await service.amend_attendance_record(
            session_id=ctx["session"].id,
            student_user_id=ctx["student"].id,
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="Student trying to self-amend",
            current_user=ctx["student"],
            eval_date=eval_date,
        )


@pytest.mark.asyncio
async def test_get_amendments_retrieval(
    db_session: AsyncSession, amendment_unit_fixture: dict
):
    """
    T068: Test audit history queries:
    - get_session_amendments
    - get_student_amendments
    """
    ctx = amendment_unit_fixture
    service = AmendmentService(db_session, correction_window_days=7)
    eval_date = ctx["session_date"] + timedelta(days=1)

    # First amendment: ABSENT -> PRESENT
    await service.amend_attendance_record(
        session_id=ctx["session"].id,
        student_user_id=ctx["student"].id,
        new_status=AttendanceStatus.PRESENT,
        amendment_reason="First amendment reason approved",
        current_user=ctx["reg_faculty"],
        eval_date=eval_date,
    )

    # Second amendment: PRESENT -> EXCUSED
    await service.amend_attendance_record(
        session_id=ctx["session"].id,
        student_user_id=ctx["student"].id,
        new_status=AttendanceStatus.EXCUSED,
        amendment_reason="Second amendment administrative excuse",
        current_user=ctx["admin"],
        eval_date=eval_date,
    )

    session_audits = await service.get_session_amendments(ctx["session"].id)
    assert len(session_audits) == 2
    assert session_audits[0].new_status == AttendanceStatus.PRESENT
    assert session_audits[1].new_status == AttendanceStatus.EXCUSED

    student_audits = await service.get_student_amendments(ctx["student"].id)
    assert len(student_audits) == 2


@pytest.mark.asyncio
async def test_amendment_service_idempotency_replay(
    db_session: AsyncSession, amendment_unit_fixture: dict
):
    """
    Phase 9.1: Repeating amend_attendance_record with the same client_amendment_id
    returns the existing audit with is_already_synced=True and does not mutate record again.
    """
    ctx = amendment_unit_fixture
    service = AmendmentService(db_session, correction_window_days=7)
    client_amd_id = uuid.uuid4()
    eval_date = ctx["session_date"] + timedelta(days=1)

    # First call: creates audit
    audit1 = await service.amend_attendance_record(
        session_id=ctx["session"].id,
        student_user_id=ctx["student"].id,
        new_status=AttendanceStatus.PRESENT,
        amendment_reason="First call with client_amendment_id",
        current_user=ctx["reg_faculty"],
        eval_date=eval_date,
        client_amendment_id=client_amd_id,
        expected_previous_status=AttendanceStatus.ABSENT,
    )
    assert audit1.client_amendment_id == client_amd_id
    assert audit1.new_status == AttendanceStatus.PRESENT
    assert getattr(audit1, "is_already_synced", False) is False

    # Second call (replay): returns same audit with is_already_synced=True
    audit2 = await service.amend_attendance_record(
        session_id=ctx["session"].id,
        student_user_id=ctx["student"].id,
        new_status=AttendanceStatus.PRESENT,
        amendment_reason="First call with client_amendment_id",
        current_user=ctx["reg_faculty"],
        eval_date=eval_date,
        client_amendment_id=client_amd_id,
        expected_previous_status=AttendanceStatus.ABSENT,
    )
    assert audit2.id == audit1.id
    assert audit2.client_amendment_id == client_amd_id
    assert getattr(audit2, "is_already_synced", False) is True

    # Confirm only 1 audit row in DB
    all_audits = await service.get_session_amendments(ctx["session"].id)
    assert len(all_audits) == 1


@pytest.mark.asyncio
async def test_amendment_service_stale_optimistic_concurrency_conflict(
    db_session: AsyncSession, amendment_unit_fixture: dict
):
    """
    Phase 9.1: Supplying an expected_previous_status that differs from current DB status
    raises StaleAmendmentError without mutating record or creating audit.
    """
    from src.core.exceptions import StaleAmendmentError

    ctx = amendment_unit_fixture
    service = AmendmentService(db_session, correction_window_days=7)
    eval_date = ctx["session_date"] + timedelta(days=1)

    # Initial state is ABSENT. Attempt amendment with expected_previous_status=EXCUSED
    with pytest.raises(StaleAmendmentError) as exc_info:
        await service.amend_attendance_record(
            session_id=ctx["session"].id,
            student_user_id=ctx["student"].id,
            new_status=AttendanceStatus.PRESENT,
            amendment_reason="Attempting amendment on stale assumption",
            current_user=ctx["reg_faculty"],
            eval_date=eval_date,
            client_amendment_id=uuid.uuid4(),
            expected_previous_status=AttendanceStatus.EXCUSED,
        )
    assert "Optimistic concurrency conflict" in str(exc_info.value)

    # Confirm no audit was created
    all_audits = await service.get_session_amendments(ctx["session"].id)
    assert len(all_audits) == 0

