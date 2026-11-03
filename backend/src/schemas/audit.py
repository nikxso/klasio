from datetime import datetime
from typing import Optional
import uuid
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from src.models.attendance import AmendmentRole, AttendanceAmendmentAudit, AttendanceStatus


class SubmitAmendmentRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    client_amendment_id: Optional[uuid.UUID] = Field(
        None,
        validation_alias=AliasChoices("client_amendment_id", "clientAmendmentId"),
        serialization_alias="client_amendment_id",
    )
    student_user_id: uuid.UUID = Field(
        ...,
        validation_alias=AliasChoices("student_user_id", "studentUserId"),
        serialization_alias="student_user_id",
    )
    expected_previous_status: Optional[AttendanceStatus] = Field(
        None,
        validation_alias=AliasChoices("expected_previous_status", "expectedPreviousStatus"),
        serialization_alias="expected_previous_status",
    )
    new_status: AttendanceStatus = Field(
        ...,
        validation_alias=AliasChoices("new_status", "newStatus"),
        serialization_alias="new_status",
    )
    amendment_reason: str = Field(
        ...,
        min_length=10,
        validation_alias=AliasChoices("amendment_reason", "amendmentReason"),
        serialization_alias="amendment_reason",
    )

    @field_validator("amendment_reason")
    @classmethod
    def validate_amendment_reason(cls, v: str) -> str:
        stripped = v.strip()
        if len(stripped) < 10:
            raise ValueError("amendment_reason must contain at least 10 non-whitespace characters")
        return stripped


class AmendmentAuditResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    audit_id: uuid.UUID = Field(
        ...,
        validation_alias=AliasChoices("audit_id", "id", "auditId"),
        serialization_alias="audit_id",
    )
    client_amendment_id: Optional[uuid.UUID] = Field(
        None,
        validation_alias=AliasChoices("client_amendment_id", "clientAmendmentId"),
        serialization_alias="client_amendment_id",
    )
    session_id: uuid.UUID = Field(
        ...,
        validation_alias=AliasChoices("session_id", "attendance_session_id", "sessionId"),
        serialization_alias="session_id",
    )
    student_user_id: uuid.UUID = Field(
        ...,
        validation_alias=AliasChoices("student_user_id", "studentUserId"),
        serialization_alias="student_user_id",
    )
    previous_status: AttendanceStatus = Field(
        ...,
        validation_alias=AliasChoices("previous_status", "previousStatus"),
        serialization_alias="previous_status",
    )
    new_status: AttendanceStatus = Field(
        ...,
        validation_alias=AliasChoices("new_status", "newStatus"),
        serialization_alias="new_status",
    )
    amending_user_id: uuid.UUID = Field(
        ...,
        validation_alias=AliasChoices("amending_user_id", "amendingUserId"),
        serialization_alias="amending_user_id",
    )
    amendment_role: AmendmentRole = Field(
        ...,
        validation_alias=AliasChoices("amendment_role", "amendmentRole"),
        serialization_alias="amendment_role",
    )
    amendment_reason: str = Field(
        ...,
        validation_alias=AliasChoices("amendment_reason", "amendmentReason"),
        serialization_alias="amendment_reason",
    )
    amended_at: datetime = Field(
        ...,
        validation_alias=AliasChoices("amended_at", "amendedAt"),
        serialization_alias="amended_at",
    )
    is_already_synced: bool = Field(
        False,
        validation_alias=AliasChoices("is_already_synced", "isAlreadySynced"),
        serialization_alias="is_already_synced",
    )

    @classmethod
    def from_audit(
        cls, audit: AttendanceAmendmentAudit, is_already_synced: Optional[bool] = None
    ) -> "AmendmentAuditResponse":
        synced = (
            is_already_synced
            if is_already_synced is not None
            else getattr(audit, "is_already_synced", False)
        )
        return cls(
            audit_id=audit.id,
            client_amendment_id=audit.client_amendment_id,
            session_id=audit.attendance_session_id,
            student_user_id=audit.student_user_id,
            previous_status=audit.previous_status,
            new_status=audit.new_status,
            amending_user_id=audit.amending_user_id,
            amendment_role=audit.amendment_role,
            amendment_reason=audit.amendment_reason,
            amended_at=audit.amended_at,
            is_already_synced=bool(synced),
        )
