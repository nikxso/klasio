from datetime import date, datetime, timezone
import enum
import hashlib
import json
from typing import Any, Dict, List, Optional
import uuid
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

from src.models.attendance import (
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
    AttendanceSessionStatus,
)


class AttendanceRecordItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    student_user_id: uuid.UUID = Field(..., validation_alias=AliasChoices("student_user_id", "studentUserId"))
    attendance_status: AttendanceStatus = Field(..., validation_alias=AliasChoices("attendance_status", "attendanceStatus"))
    mark_source: MarkSource = Field(default=MarkSource.MANUAL_MARK, validation_alias=AliasChoices("mark_source", "markSource"))
    candidate_confidence: Optional[float] = Field(default=None, validation_alias=AliasChoices("candidate_confidence", "candidateConfidence"))
    recorded_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        validation_alias=AliasChoices("recorded_at", "recordedAt"),
    )


class SubmitAttendanceSessionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    client_session_uuid: uuid.UUID = Field(..., validation_alias=AliasChoices("client_session_uuid", "clientSessionUuid"))
    teaching_assignment_id: uuid.UUID = Field(..., validation_alias=AliasChoices("teaching_assignment_id", "teachingAssignmentId"))
    session_date: date = Field(..., validation_alias=AliasChoices("session_date", "sessionDate"))
    period_slot_or_sequence: int = Field(default=1, ge=1, validation_alias=AliasChoices("period_slot_or_sequence", "periodSlotOrSequence"))
    applicability_status: SessionApplicability = Field(
        default=SessionApplicability.COUNTED,
        validation_alias=AliasChoices("applicability_status", "applicabilityStatus"),
    )
    status_reason: Optional[str] = Field(default=None, validation_alias=AliasChoices("status_reason", "statusReason"))
    regular_faculty_user_id: Optional[uuid.UUID] = Field(default=None, validation_alias=AliasChoices("regular_faculty_user_id", "regularFacultyUserId"))
    conducting_faculty_user_id: Optional[uuid.UUID] = Field(default=None, validation_alias=AliasChoices("conducting_faculty_user_id", "conductingFacultyUserId"))
    substitute_delegation_id: Optional[uuid.UUID] = Field(default=None, validation_alias=AliasChoices("substitute_delegation_id", "substituteDelegationId"))
    finalized_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        validation_alias=AliasChoices("finalized_at", "finalizedAt"),
    )
    records: List[AttendanceRecordItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_session_invariants(self) -> "SubmitAttendanceSessionRequest":
        # 1. Applicability status reason validation
        if self.applicability_status != SessionApplicability.COUNTED:
            if not self.status_reason or not self.status_reason.strip():
                raise ValueError(
                    f"status_reason is mandatory for session with applicability {self.applicability_status.value}"
                )

        # 2. Duplicate student ID check within payload
        student_ids = [rec.student_user_id for rec in self.records]
        if len(student_ids) != len(set(student_ids)):
            seen = set()
            duplicates = [s for s in student_ids if s in seen or seen.add(s)]
            raise ValueError(f"Payload contains duplicate attendance records for student(s): {duplicates}")

        return self

    def compute_canonical_hash(self) -> str:
        """
        Compute deterministic SHA-256 hash of the session's decisions and metadata.
        Ensures that repeated requests with same client_session_uuid are verified for content identity.
        Sorts records deterministically by student_user_id (canonical identity).
        Neutralizes key ordering via sorted JSON key serialization with compact separators.
        """
        sorted_records = sorted(
            [
                (
                    str(r.student_user_id),
                    r.attendance_status.value,
                    r.mark_source.value,
                    round(r.candidate_confidence, 4) if r.candidate_confidence is not None else None,
                )
                for r in self.records
            ],
            key=lambda x: x[0],
        )
        canonical_dict = {
            "applicability": self.applicability_status.value,
            "assignment": str(self.teaching_assignment_id),
            "date": str(self.session_date),
            "records": sorted_records,
            "slot": self.period_slot_or_sequence,
            "status_reason": self.status_reason,
        }
        canonical_str = json.dumps(canonical_dict, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical_str.encode("utf-8")).hexdigest()


class AttendanceSessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    client_session_uuid: uuid.UUID
    teaching_assignment_id: uuid.UUID
    session_date: date
    period_slot_or_sequence: int
    applicability_status: SessionApplicability
    status_reason: Optional[str]
    regular_faculty_user_id: uuid.UUID
    conducting_faculty_user_id: uuid.UUID
    substitute_delegation_id: Optional[uuid.UUID]
    session_status: AttendanceSessionStatus
    finalized_at: datetime
    records_count: int
    present_count: int
    absent_count: int
    excused_count: int
    created_at: datetime


class BatchSyncRequest(BaseModel):
    sessions: List[SubmitAttendanceSessionRequest]


class SyncResultStatus(str, enum.Enum):
    SYNCED = "SYNCED"
    ALREADY_SYNCED = "ALREADY_SYNCED"
    CONFLICT = "CONFLICT"
    REJECTED = "REJECTED"


class BatchSyncResultItem(BaseModel):
    client_session_uuid: uuid.UUID
    status: SyncResultStatus
    server_session_id: Optional[uuid.UUID] = None
    error_message: Optional[str] = None
    records_count: Optional[int] = None
    present_count: Optional[int] = None
    absent_count: Optional[int] = None
    excused_count: Optional[int] = None


class BatchSyncResponse(BaseModel):
    results: List[BatchSyncResultItem]
