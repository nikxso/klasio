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
