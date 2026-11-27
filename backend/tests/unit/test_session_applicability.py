from datetime import date, datetime, timezone
import uuid
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.main import app
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import TeachingAssignment
from src.models.attendance import (
    AttendanceRecord,
    AttendanceSession,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
)
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import AccountStatus, User, UserRole
from src.schemas.attendance import (
    AttendanceRecordItem,
    SubmitAttendanceSessionRequest,
)
from src.services.attendance_service import AttendanceService
from src.services.enrollment_service import EnrollmentService


@pytest.fixture
async def multi_session_fixture(db_session: AsyncSession):
    """
    Sets up a complete academic context for multi-session and applicability testing:
    - 1 Department (CSE)
    - 1 Active Term (Fall 2026)
    - 1 Subject (CS301)
    - 1 Class Section (CSE-3A)
    - 1 Faculty User (Prof Harrison)
    - 1 Teaching Assignment (Harrison -> CSE-3A)
    - 5 Enrolled Students (stu_1 through stu_5)
    """
    dept = Department(code="CSE-MS", name="Computer Science Dept")
    term = AcademicTerm(
        code="2026-FALL-MS",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS301-MS", name="Data Structures", department_id=dept.id, credits=3)
    section = ClassSection(section_code="CSE-3A", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    db_session.add_all([subject, section])
    await db_session.flush()

    faculty = User(
        institutional_id="FAC-MS-01",
        email="faculty_ms@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Harrison",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(faculty)
    await db_session.flush()

    assignment = TeachingAssignment(
        faculty_user_id=faculty.id,
        class_section_id=section.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        is_active=True,
        created_by_user_id=faculty.id,
    )
    db_session.add(assignment)
    await db_session.flush()

    students = []
    enrollments = []
    for i in range(1, 6):
        stu = User(
            institutional_id=f"STU-MS-{i:03d}",
            email=f"stu_ms_{i}@institution.edu",
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
            class_section_id=section.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 15),
            effective_end_date=None,
            enrollment_status=EnrollmentStatus.ACTIVE,
        )
        enrollments.append(enr)
    db_session.add_all(enrollments)
    await db_session.commit()

    return {
        "faculty": faculty,
        "assignment": assignment,
        "students": students,
        "term": term,
        "section": section,
    }


def make_records(students, statuses):
    now = datetime.now(timezone.utc)
    return [
        AttendanceRecordItem(
            studentUserId=stu.id,
            attendanceStatus=status,
            markSource=MarkSource.MANUAL_MARK,
            recordedAt=now,
        )
        for stu, status in zip(students, statuses)
    ]


@pytest.mark.asyncio
async def test_multi_session_same_day_different_slots(multi_session_fixture, db_session: AsyncSession):
    """
    Verifies that multiple attendance sessions for the same teaching assignment on the same date
    are accepted when they have different period_slot_or_sequence values.
    """
    faculty = multi_session_fixture["faculty"]
    assignment = multi_session_fixture["assignment"]
    students = multi_session_fixture["students"]
    service = AttendanceService(db_session)

    session_date = date(2026, 10, 14)
    now = datetime.now(timezone.utc)

    # Session 1: Slot 1 (Period 1)
    uuid_slot_1 = uuid.uuid4()
    req_slot_1 = SubmitAttendanceSessionRequest(
        clientSessionUuid=uuid_slot_1,
        teachingAssignmentId=assignment.id,
        sessionDate=session_date,
        periodSlotOrSequence=1,
        applicabilityStatus=SessionApplicability.COUNTED,
        finalizedAt=now,
        records=make_records(students, [AttendanceStatus.PRESENT] * 5),
    )
    res_slot_1 = await service.sync_session(faculty, req_slot_1)
    assert res_slot_1.status.value in ["SYNCED", "ALREADY_SYNCED"]
    assert res_slot_1.records_count == 5
    assert res_slot_1.present_count == 5

    # Session 2: Slot 3 (Period 3) on the SAME DATE for the SAME ASSIGNMENT
    uuid_slot_3 = uuid.uuid4()
    req_slot_3 = SubmitAttendanceSessionRequest(
        clientSessionUuid=uuid_slot_3,
        teachingAssignmentId=assignment.id,
        sessionDate=session_date,
        periodSlotOrSequence=3,
        applicabilityStatus=SessionApplicability.COUNTED,
        finalizedAt=now,
        records=make_records(
            students,
            [
                AttendanceStatus.PRESENT,
                AttendanceStatus.ABSENT,
                AttendanceStatus.PRESENT,
                AttendanceStatus.PRESENT,
                AttendanceStatus.ABSENT,
            ],
        ),
    )
    res_slot_3 = await service.sync_session(faculty, req_slot_3)
    assert res_slot_3.status.value in ["SYNCED", "ALREADY_SYNCED"]
    assert res_slot_3.records_count == 5
    assert res_slot_3.present_count == 3
    assert res_slot_3.absent_count == 2

    # Query database to confirm both sessions exist independently
    stmt = (
        select(AttendanceSession)
        .where(
            AttendanceSession.teaching_assignment_id == assignment.id,
            AttendanceSession.session_date == session_date,
        )
        .order_by(AttendanceSession.period_slot_or_sequence)
    )
    res = await db_session.execute(stmt)
    sessions = res.scalars().all()
    assert len(sessions) == 2
    assert sessions[0].period_slot_or_sequence == 1
    assert sessions[0].client_session_uuid == uuid_slot_1
    assert sessions[1].period_slot_or_sequence == 3
    assert sessions[1].client_session_uuid == uuid_slot_3


@pytest.mark.asyncio
async def test_same_slot_duplicate_rejected(multi_session_fixture, db_session: AsyncSession):
    """
    Verifies that attempting to create a second session with the same
    (teaching_assignment_id, session_date, period_slot_or_sequence) is rejected as a CONFLICT (409).
    """
    faculty = multi_session_fixture["faculty"]
    assignment = multi_session_fixture["assignment"]
    students = multi_session_fixture["students"]
    service = AttendanceService(db_session)

    session_date = date(2026, 10, 15)
    now = datetime.now(timezone.utc)

    # First session on Slot 2
    uuid_first = uuid.uuid4()
    req_first = SubmitAttendanceSessionRequest(
        clientSessionUuid=uuid_first,
        teachingAssignmentId=assignment.id,
        sessionDate=session_date,
        periodSlotOrSequence=2,
        applicabilityStatus=SessionApplicability.COUNTED,
        finalizedAt=now,
        records=make_records(students, [AttendanceStatus.PRESENT] * 5),
    )
    res_first = await service.sync_session(faculty, req_first)
    assert res_first.status.value in ["SYNCED", "ALREADY_SYNCED"]

    # Conflicting session: Different client UUID, same assignment, date, and Slot 2
    uuid_conflict = uuid.uuid4()
    req_conflict = SubmitAttendanceSessionRequest(
        clientSessionUuid=uuid_conflict,
        teachingAssignmentId=assignment.id,
        sessionDate=session_date,
        periodSlotOrSequence=2,
        applicabilityStatus=SessionApplicability.COUNTED,
        finalizedAt=now,
        records=make_records(students, [AttendanceStatus.ABSENT] * 5),
    )
    res_conflict = await service.sync_session(faculty, req_conflict)
    assert res_conflict.status.value == "CONFLICT"
    assert "already finalized" in res_conflict.error_message


@pytest.mark.asyncio
async def test_session_applicability_counted_increments_denominator(multi_session_fixture, db_session: AsyncSession):
    """
    Verifies that COUNTED sessions correctly increment the attendance calculation denominator.
    Two counted sessions on the same day = total eligible sessions: 2.
    """
    faculty = multi_session_fixture["faculty"]
    assignment = multi_session_fixture["assignment"]
    students = multi_session_fixture["students"]
    service = AttendanceService(db_session)

    session_date = date(2026, 10, 16)
    now = datetime.now(timezone.utc)
    student_0 = students[0]

    # Session 1 (Slot 1): Student 0 PRESENT
    await service.sync_session(
        faculty,
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=assignment.id,
            sessionDate=session_date,
            periodSlotOrSequence=1,
            applicabilityStatus=SessionApplicability.COUNTED,
            finalizedAt=now,
            records=make_records(students, [AttendanceStatus.PRESENT] * 5),
        ),
    )

    # Session 2 (Slot 2): Student 0 ABSENT
    await service.sync_session(
        faculty,
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=assignment.id,
            sessionDate=session_date,
            periodSlotOrSequence=2,
            applicabilityStatus=SessionApplicability.COUNTED,
            finalizedAt=now,
            records=make_records(
                students,
                [
                    AttendanceStatus.ABSENT,
                    AttendanceStatus.PRESENT,
                    AttendanceStatus.PRESENT,
                    AttendanceStatus.PRESENT,
                    AttendanceStatus.PRESENT,
                ],
            ),
        ),
    )

    # Verify student attendance percentage: 1 present out of 2 counted sessions = 50.0%
    enrollment_service = EnrollmentService(db_session)
    report = await enrollment_service.calculate_student_personal_attendance(
        student_user_id=student_0.id,
        academic_term_id=multi_session_fixture["term"].id,
    )
    assert len(report.subjects) == 1
    summary = report.subjects[0]
    assert summary.total_eligible_sessions == 2
    assert summary.attended_sessions == 1
    assert summary.attendance_percentage == 50.0


@pytest.mark.asyncio
async def test_session_applicability_cancelled_excludes_from_denominator(multi_session_fixture, db_session: AsyncSession):
    """
    Verifies that CANCELLED sessions do NOT increment the attendance denominator.
    1 COUNTED session + 1 CANCELLED session = total eligible sessions: 1 (not 2).
    """
    faculty = multi_session_fixture["faculty"]
    assignment = multi_session_fixture["assignment"]
    students = multi_session_fixture["students"]
    service = AttendanceService(db_session)

    session_date = date(2026, 10, 17)
    now = datetime.now(timezone.utc)
    student_0 = students[0]

    # Session 1: COUNTED (Student 0 PRESENT)
    await service.sync_session(
        faculty,
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=assignment.id,
            sessionDate=session_date,
            periodSlotOrSequence=1,
            applicabilityStatus=SessionApplicability.COUNTED,
            finalizedAt=now,
            records=make_records(students, [AttendanceStatus.PRESENT] * 5),
        ),
    )

    # Session 2: CANCELLED with reason (all students marked EXCUSED)
    await service.sync_session(
        faculty,
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=assignment.id,
            sessionDate=session_date,
            periodSlotOrSequence=2,
            applicabilityStatus=SessionApplicability.CANCELLED,
            statusReason="Campus-wide power outage and evacuation",
            finalizedAt=now,
            records=make_records(students, [AttendanceStatus.EXCUSED] * 5),
        ),
    )

    # Student personal attendance: only the 1 COUNTED session contributes to denominator
    enrollment_service = EnrollmentService(db_session)
    report = await enrollment_service.calculate_student_personal_attendance(
        student_user_id=student_0.id,
        academic_term_id=multi_session_fixture["term"].id,
    )
    assert len(report.subjects) == 1
    summary = report.subjects[0]
    assert summary.total_eligible_sessions == 1  # Not 2!
    assert summary.attended_sessions == 1
    assert summary.attendance_percentage == 100.0


@pytest.mark.asyncio
async def test_session_applicability_exempt_excludes_from_denominator(multi_session_fixture, db_session: AsyncSession):
    """
    Verifies that EXEMPT sessions do NOT increment the attendance denominator.
    1 COUNTED session + 1 EXEMPT session = total eligible sessions: 1.
    """
    faculty = multi_session_fixture["faculty"]
    assignment = multi_session_fixture["assignment"]
    students = multi_session_fixture["students"]
    service = AttendanceService(db_session)

    session_date = date(2026, 10, 18)
    now = datetime.now(timezone.utc)
    student_0 = students[0]

    # Session 1: COUNTED (Student 0 PRESENT)
    await service.sync_session(
        faculty,
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=assignment.id,
            sessionDate=session_date,
            periodSlotOrSequence=1,
            applicabilityStatus=SessionApplicability.COUNTED,
            finalizedAt=now,
            records=make_records(students, [AttendanceStatus.PRESENT] * 5),
        ),
    )

    # Session 2: EXEMPT with institutional reason
    await service.sync_session(
        faculty,
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=assignment.id,
            sessionDate=session_date,
            periodSlotOrSequence=2,
            applicabilityStatus=SessionApplicability.EXEMPT,
            statusReason="Annual College Tech Symposium - Class Excused",
            finalizedAt=now,
            records=make_records(students, [AttendanceStatus.EXCUSED] * 5),
        ),
    )

    enrollment_service = EnrollmentService(db_session)
    report = await enrollment_service.calculate_student_personal_attendance(
        student_user_id=student_0.id,
        academic_term_id=multi_session_fixture["term"].id,
    )
    assert len(report.subjects) == 1
    summary = report.subjects[0]
    assert summary.total_eligible_sessions == 1
    assert summary.attended_sessions == 1
    assert summary.attendance_percentage == 100.0


def test_status_reason_mandatory_for_cancelled_and_exempt():
    """
    Verifies schema invariant: status_reason is strictly mandatory
    when applicability_status is CANCELLED or EXEMPT.
    """
    now = datetime.now(timezone.utc)

    # COUNTED without reason is valid
    valid_counted = SubmitAttendanceSessionRequest(
        clientSessionUuid=uuid.uuid4(),
        teachingAssignmentId=uuid.uuid4(),
        sessionDate=date(2026, 10, 19),
        periodSlotOrSequence=1,
        applicabilityStatus=SessionApplicability.COUNTED,
        statusReason=None,
        finalizedAt=now,
        records=[],
    )
    assert valid_counted.status_reason is None

    # CANCELLED without reason must raise ValueError
    with pytest.raises(ValueError, match="status_reason is mandatory"):
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=uuid.uuid4(),
            sessionDate=date(2026, 10, 19),
            periodSlotOrSequence=1,
            applicabilityStatus=SessionApplicability.CANCELLED,
            statusReason=None,
            finalizedAt=now,
            records=[],
        )

    # EXEMPT with whitespace-only reason must raise ValueError
    with pytest.raises(ValueError, match="status_reason is mandatory"):
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=uuid.uuid4(),
            sessionDate=date(2026, 10, 19),
            periodSlotOrSequence=1,
            applicabilityStatus=SessionApplicability.EXEMPT,
            statusReason="   ",
            finalizedAt=now,
            records=[],
        )
