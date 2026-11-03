import json
from datetime import date, datetime, timezone
import uuid
import pytest
from pydantic import ValidationError

from src.models.attendance import (
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
)
from src.schemas.attendance import (
    AttendanceRecordItem,
    BatchSyncRequest,
    BatchSyncResultItem,
    SubmitAttendanceSessionRequest,
    SyncResultStatus,
)


def test_submit_session_schema_validation_success():
    client_uuid = uuid.uuid4()
    ta_id = uuid.uuid4()
    s1 = uuid.uuid4()
    s2 = uuid.uuid4()

    req = SubmitAttendanceSessionRequest(
        clientSessionUuid=client_uuid,
        teachingAssignmentId=ta_id,
        sessionDate=date(2026, 10, 13),
        periodSlotOrSequence=1,
        applicabilityStatus=SessionApplicability.COUNTED,
        finalizedAt=datetime.now(timezone.utc),
        records=[
            AttendanceRecordItem(
                studentUserId=s1,
                attendanceStatus=AttendanceStatus.PRESENT,
                markSource=MarkSource.AI_VERIFIED,
                candidateConfidence=0.912,
                recordedAt=datetime.now(timezone.utc),
            ),
            AttendanceRecordItem(
                studentUserId=s2,
                attendanceStatus=AttendanceStatus.ABSENT,
                markSource=MarkSource.MANUAL_MARK,
                recordedAt=datetime.now(timezone.utc),
            ),
        ],
    )
    assert req.client_session_uuid == client_uuid
    assert req.teaching_assignment_id == ta_id
    assert len(req.records) == 2


def test_submit_session_rejects_duplicate_students_in_payload():
    student_id = uuid.uuid4()
    with pytest.raises(ValidationError) as exc_info:
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=uuid.uuid4(),
            sessionDate=date(2026, 10, 13),
            periodSlotOrSequence=1,
            applicabilityStatus=SessionApplicability.COUNTED,
            finalizedAt=datetime.now(timezone.utc),
            records=[
                AttendanceRecordItem(
                    studentUserId=student_id,
                    attendanceStatus=AttendanceStatus.PRESENT,
                    markSource=MarkSource.AI_VERIFIED,
                    recordedAt=datetime.now(timezone.utc),
                ),
                AttendanceRecordItem(
                    studentUserId=student_id,
                    attendanceStatus=AttendanceStatus.ABSENT,
                    markSource=MarkSource.MANUAL_MARK,
                    recordedAt=datetime.now(timezone.utc),
                ),
            ],
        )
    assert "Payload contains duplicate attendance records" in str(exc_info.value)


def test_submit_session_requires_reason_for_cancelled_or_exempt():
    with pytest.raises(ValidationError) as exc_info:
        SubmitAttendanceSessionRequest(
            clientSessionUuid=uuid.uuid4(),
            teachingAssignmentId=uuid.uuid4(),
            sessionDate=date(2026, 10, 13),
            periodSlotOrSequence=1,
            applicabilityStatus=SessionApplicability.CANCELLED,
            statusReason=None,  # Missing mandatory reason
            finalizedAt=datetime.now(timezone.utc),
            records=[],
        )
    assert "status_reason is mandatory" in str(exc_info.value)


def test_canonical_hash_same_payload_identical_hash():
    """TASK 1 (1): Same logical payload produces identical canonical hash."""
    client_uuid = uuid.uuid4()
    ta_id = uuid.uuid4()
    s1 = uuid.uuid4()
    now = datetime(2026, 10, 13, 10, 0, 0, tzinfo=timezone.utc)

    req = SubmitAttendanceSessionRequest(
        clientSessionUuid=client_uuid,
        teachingAssignmentId=ta_id,
        sessionDate=date(2026, 10, 13),
        periodSlotOrSequence=1,
        applicabilityStatus=SessionApplicability.COUNTED,
        finalizedAt=now,
        records=[
            AttendanceRecordItem(
                studentUserId=s1,
                attendanceStatus=AttendanceStatus.PRESENT,
                markSource=MarkSource.AI_VERIFIED,
                candidateConfidence=0.912,
                recordedAt=now,
            )
        ],
    )
    hash1 = req.compute_canonical_hash()
    hash2 = req.compute_canonical_hash()
    assert hash1 == hash2
    assert len(hash1) == 64


def test_canonical_hash_json_key_order_independence():
    """TASK 1 (2): Same payload with JSON key order changed produces identical hash."""
    client_uuid = str(uuid.uuid4())
    ta_id = str(uuid.uuid4())
    s1 = str(uuid.uuid4())
    now_iso = "2026-10-13T10:00:00Z"

    # JSON A: standard key ordering
    json_a = json.dumps({
        "clientSessionUuid": client_uuid,
        "teachingAssignmentId": ta_id,
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "finalizedAt": now_iso,
        "records": [
            {
                "studentUserId": s1,
                "attendanceStatus": "PRESENT",
                "markSource": "AI_VERIFIED",
                "candidateConfidence": 0.885,
                "recordedAt": now_iso,
            }
        ],
    })

    # JSON B: scrambled key ordering at root level and record level
    json_b = json.dumps({
        "records": [
            {
                "candidateConfidence": 0.885,
                "recordedAt": now_iso,
                "attendanceStatus": "PRESENT",
                "markSource": "AI_VERIFIED",
                "studentUserId": s1,
            }
        ],
        "finalizedAt": now_iso,
        "applicabilityStatus": "COUNTED",
        "periodSlotOrSequence": 1,
        "teachingAssignmentId": ta_id,
        "sessionDate": "2026-10-13",
        "clientSessionUuid": client_uuid,
    })

    req_a = SubmitAttendanceSessionRequest.model_validate_json(json_a)
    req_b = SubmitAttendanceSessionRequest.model_validate_json(json_b)

    assert req_a.compute_canonical_hash() == req_b.compute_canonical_hash()


def test_canonical_hash_record_order_independence():
    """TASK 1 (3): Same records in different order yield identical hash; changed decisions yield different hash."""
    client_uuid = uuid.uuid4()
    ta_id = uuid.uuid4()
    s1 = uuid.uuid4()
    s2 = uuid.uuid4()
    s3 = uuid.uuid4()
    now = datetime(2026, 10, 13, 10, 0, 0, tzinfo=timezone.utc)

    records_orig = [
        AttendanceRecordItem(
            studentUserId=s1,
            attendanceStatus=AttendanceStatus.PRESENT,
            markSource=MarkSource.AI_VERIFIED,
            candidateConfidence=0.92,
            recordedAt=now,
        ),
        AttendanceRecordItem(
            studentUserId=s2,
            attendanceStatus=AttendanceStatus.ABSENT,
            markSource=MarkSource.MANUAL_MARK,
            recordedAt=now,
        ),
        AttendanceRecordItem(
            studentUserId=s3,
            attendanceStatus=AttendanceStatus.PRESENT,
            markSource=MarkSource.MANUAL_MARK,
            recordedAt=now,
        ),
    ]

    records_permuted = [records_orig[2], records_orig[0], records_orig[1]]

    req1 = SubmitAttendanceSessionRequest(
        clientSessionUuid=client_uuid,
        teachingAssignmentId=ta_id,
        sessionDate=date(2026, 10, 13),
        periodSlotOrSequence=1,
        applicabilityStatus=SessionApplicability.COUNTED,
        finalizedAt=now,
        records=records_orig,
    )
    req2 = SubmitAttendanceSessionRequest(
        clientSessionUuid=client_uuid,
        teachingAssignmentId=ta_id,
        sessionDate=date(2026, 10, 13),
        periodSlotOrSequence=1,
        applicabilityStatus=SessionApplicability.COUNTED,
        finalizedAt=now,
        records=records_permuted,
    )

    assert req1.compute_canonical_hash() == req2.compute_canonical_hash()

    # Modified attendance status for s2
    req_altered = SubmitAttendanceSessionRequest(
        clientSessionUuid=client_uuid,
        teachingAssignmentId=ta_id,
        sessionDate=date(2026, 10, 13),
        periodSlotOrSequence=1,
        applicabilityStatus=SessionApplicability.COUNTED,
        finalizedAt=now,
        records=[
            records_orig[0],
            AttendanceRecordItem(
                studentUserId=s2,
                attendanceStatus=AttendanceStatus.EXCUSED,
                markSource=MarkSource.MANUAL_MARK,
                recordedAt=now,
            ),
            records_orig[2],
        ],
    )
    assert req1.compute_canonical_hash() != req_altered.compute_canonical_hash()
