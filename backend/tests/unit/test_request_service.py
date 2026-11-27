from datetime import date, datetime, timezone
import uuid
import pytest
from pydantic import ValidationError

from src.models.attendance import AttendanceRequestStatus
from src.schemas.request import (
    CreateAttendanceRequest,
    ResolveAttendanceRequest,
    StudentAttendanceRequestResponse,
)


def test_create_attendance_request_validation():
    # Valid payload
    payload = CreateAttendanceRequest(
        teaching_assignment_id=uuid.uuid4(),
        session_date=date(2026, 10, 2),
        student_note="I was present in the back row during the lecture.",
    )
    assert payload.session_date == date(2026, 10, 2)
    assert len(payload.student_note) > 10

    # Short note rejected
    with pytest.raises(ValidationError):
        CreateAttendanceRequest(
            teaching_assignment_id=uuid.uuid4(),
            session_date=date(2026, 10, 2),
            student_note="a",
        )


def test_resolve_attendance_request_validation():
    # Valid approve
    resolve_ok = ResolveAttendanceRequest(
        status=AttendanceRequestStatus.APPROVED,
        resolution_note="Verified attendance photo roll - student was present.",
    )
    assert resolve_ok.status == AttendanceRequestStatus.APPROVED

    # Valid reject
    resolve_rej = ResolveAttendanceRequest(
        status=AttendanceRequestStatus.REJECTED,
        resolution_note="No record found and student was confirmed absent.",
    )
    assert resolve_rej.status == AttendanceRequestStatus.REJECTED

    # Invalid status string rejected
    with pytest.raises(ValidationError):
        ResolveAttendanceRequest(
            status="UNKNOWN_STATUS",  # type: ignore
            resolution_note="Some note",
        )


def test_student_attendance_request_response_serialization():
    req_id = uuid.uuid4()
    student_id = uuid.uuid4()
    assignment_id = uuid.uuid4()
    reviewer_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    resp = StudentAttendanceRequestResponse(
        id=req_id,
        student_user_id=student_id,
        teaching_assignment_id=assignment_id,
        session_date=date(2026, 10, 2),
        student_note="Marked absent by mistake.",
        status=AttendanceRequestStatus.APPROVED,
        reviewer_user_id=reviewer_id,
        resolution_note="Correction approved.",
        created_at=now,
        resolved_at=now,
        subject_name="Operating Systems",
    )

    data = resp.model_dump()
    assert data["id"] == req_id
    assert data["status"] == AttendanceRequestStatus.APPROVED
    assert data["subject_name"] == "Operating Systems"
    assert data["resolution_note"] == "Correction approved."


@pytest.mark.asyncio
async def test_faculty_list_and_resolve_attendance_requests_flow(db_session):
    from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
    from src.models.assignment import TeachingAssignment
    from src.models.attendance import (
        AttendanceAmendmentAudit,
        AttendanceRecord,
        AttendanceSession,
        AttendanceSessionStatus,
        AttendanceStatus,
        MarkSource,
        SessionApplicability,
    )
    from src.models.user import AccountStatus, User, UserRole
    from src.services.request_service import RequestService

    dept = Department(code="CSE-REQ", name="Computer Science")
    term = AcademicTerm(
        code="2026-FALL-REQ",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS101-REQ", name="Data Structures", department_id=dept.id, credits=4)
    section = ClassSection(section_code="CSE-1A-REQ", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    db_session.add_all([subject, section])
    await db_session.flush()

    faculty = User(
        institutional_id="FAC-REQ-01",
        email="fac_req@institution.edu",
        password_hash="dummy",
        full_name="Prof Jane Smith",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student = User(
        institutional_id="STU-REQ-01",
        email="stu_req@institution.edu",
        password_hash="dummy",
        full_name="Alice Student",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([faculty, student])
    await db_session.flush()

    assignment = TeachingAssignment(
        class_section_id=section.id,
        subject_id=subject.id,
        faculty_user_id=faculty.id,
        created_by_user_id=faculty.id,
        academic_term_id=term.id,
        is_active=True,
    )
    db_session.add(assignment)
    await db_session.flush()

    # Session on 2026-11-20
    sess_date = date(2026, 11, 20)
    session = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=assignment.id,
        session_date=sess_date,
        period_slot_or_sequence=1,
        conducting_faculty_user_id=faculty.id,
        regular_faculty_user_id=faculty.id,
        session_status=AttendanceSessionStatus.FINALIZED,
        applicability_status=SessionApplicability.COUNTED,
        records_count=1,
        present_count=0,
        absent_count=1,
    )
    db_session.add(session)
    await db_session.flush()

    record = AttendanceRecord(
        attendance_session_id=session.id,
        student_user_id=student.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
    )
    db_session.add(record)
    await db_session.flush()

    # 1. Student submits request
    service = RequestService(db_session)
    create_payload = CreateAttendanceRequest(
        teaching_assignment_id=assignment.id,
        session_date=sess_date,
        student_note="I was present in the back row during the lecture.",
    )
    submitted = await service.submit_request(student, create_payload)
    assert submitted.status == AttendanceRequestStatus.PENDING

    # 2. Faculty lists reviewable requests (MUST NOT CRASH WITH AttributeError!)
    reviewer_requests = await service.list_reviewer_requests(faculty)
    assert len(reviewer_requests) == 1
    req_item = reviewer_requests[0]
    assert req_item.id == submitted.id
    assert req_item.student_name == "Alice Student"
    assert req_item.student_institutional_id == "STU-REQ-01"
    assert req_item.subject_name == "Data Structures"

    # 3. Faculty approves request: attendance must be credited and amended!
    resolve_payload = ResolveAttendanceRequest(
        status=AttendanceRequestStatus.APPROVED,
        resolution_note="Verified classroom roll - student was present.",
    )
    resolved = await service.resolve_request(faculty, req_item.id, resolve_payload)
    assert resolved.status == AttendanceRequestStatus.APPROVED
    assert resolved.resolution_note == "Verified classroom roll - student was present."

    # Verify AttendanceRecord is now PRESENT
    await db_session.refresh(record)
    assert record.attendance_status == AttendanceStatus.PRESENT
    assert record.mark_source == MarkSource.MANUAL_OVERRIDE

    # Verify session counters updated
    await db_session.refresh(session)
    assert session.present_count == 1
    assert session.absent_count == 0

    # Verify AttendanceAmendmentAudit record was created
    from sqlalchemy import select
    audit_res = await db_session.execute(
        select(AttendanceAmendmentAudit).where(
            AttendanceAmendmentAudit.attendance_session_id == session.id,
            AttendanceAmendmentAudit.student_user_id == student.id,
        )
    )
    audit = audit_res.scalar_one_or_none()
    assert audit is not None
    assert audit.previous_status == AttendanceStatus.ABSENT
    assert audit.new_status == AttendanceStatus.PRESENT


@pytest.mark.asyncio
async def test_faculty_reject_attendance_request_flow(db_session):
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
    from src.models.user import AccountStatus, User, UserRole
    from src.services.request_service import RequestService

    dept = Department(code="CSE-REJ", name="Computer Science")
    term = AcademicTerm(
        code="2026-FALL-REJ",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS102-REJ", name="Operating Systems", department_id=dept.id, credits=4)
    section = ClassSection(section_code="CSE-1B-REJ", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    db_session.add_all([subject, section])
    await db_session.flush()

    faculty = User(
        institutional_id="FAC-REJ-01",
        email="fac_rej@institution.edu",
        password_hash="dummy",
        full_name="Prof Alan Turing",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student = User(
        institutional_id="STU-REJ-01",
        email="stu_rej@institution.edu",
        password_hash="dummy",
        full_name="Bob Student",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([faculty, student])
    await db_session.flush()

    assignment = TeachingAssignment(
        class_section_id=section.id,
        subject_id=subject.id,
        faculty_user_id=faculty.id,
        created_by_user_id=faculty.id,
        academic_term_id=term.id,
        is_active=True,
    )
    db_session.add(assignment)
    await db_session.flush()

    sess_date = date(2026, 11, 21)
    session = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=assignment.id,
        session_date=sess_date,
        period_slot_or_sequence=1,
        conducting_faculty_user_id=faculty.id,
        regular_faculty_user_id=faculty.id,
        session_status=AttendanceSessionStatus.FINALIZED,
        applicability_status=SessionApplicability.COUNTED,
        records_count=1,
        present_count=0,
        absent_count=1,
    )
    db_session.add(session)
    await db_session.flush()

    record = AttendanceRecord(
        attendance_session_id=session.id,
        student_user_id=student.id,
        attendance_status=AttendanceStatus.ABSENT,
        mark_source=MarkSource.MANUAL_MARK,
    )
    db_session.add(record)
    await db_session.flush()

    service = RequestService(db_session)
    create_payload = CreateAttendanceRequest(
        teaching_assignment_id=assignment.id,
        session_date=sess_date,
        student_note="I was there during roll call.",
    )
    submitted = await service.submit_request(student, create_payload)

    # Faculty rejects with explicit reason statement
    rejection_statement = "Checked lecture CCTV footage and attendance sign-in sheet; student was absent."
    resolve_payload = ResolveAttendanceRequest(
        status=AttendanceRequestStatus.REJECTED,
        resolution_note=rejection_statement,
    )
    resolved = await service.resolve_request(faculty, submitted.id, resolve_payload)
    assert resolved.status == AttendanceRequestStatus.REJECTED
    assert resolved.resolution_note == rejection_statement

    # Verify AttendanceRecord REMAINS ABSENT
    await db_session.refresh(record)
    assert record.attendance_status == AttendanceStatus.ABSENT

    # Verify session counters remain untouched
    await db_session.refresh(session)
    assert session.present_count == 0
    assert session.absent_count == 1


