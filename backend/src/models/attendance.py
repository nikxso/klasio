from datetime import date, datetime, timezone
import enum
from typing import List, Optional
import uuid
from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Enum as SQLEnum,
    Float,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base, TimestampMixin


class SessionApplicability(str, enum.Enum):
    COUNTED = "COUNTED"
    CANCELLED = "CANCELLED"
    EXEMPT = "EXEMPT"


class AttendanceSessionStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    FINALIZED = "FINALIZED"
    SYNCED = "SYNCED"


class AttendanceStatus(str, enum.Enum):
    PRESENT = "PRESENT"
    ABSENT = "ABSENT"
    EXCUSED = "EXCUSED"


class MarkSource(str, enum.Enum):
    AI_VERIFIED = "AI_VERIFIED"
    MANUAL_MARK = "MANUAL_MARK"
    MANUAL_OVERRIDE = "MANUAL_OVERRIDE"


class AmendmentRole(str, enum.Enum):
    REGULAR_FACULTY = "REGULAR_FACULTY"
    ADMIN = "ADMIN"


class AttendanceRequestStatus(str, enum.Enum):
    PENDING = "PENDING"
    UNDER_REVIEW = "UNDER_REVIEW"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class AttendanceSession(Base, TimestampMixin):
    __tablename__ = "attendance_sessions"
    __table_args__ = (
        UniqueConstraint("teaching_assignment_id", "session_date", "period_slot_or_sequence", name="uq_assignment_session_slot"),
        UniqueConstraint("client_session_uuid", name="uq_attendance_session_client_uuid"),
        Index("ix_attendance_sessions_assignment_date", "teaching_assignment_id", "session_date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("deployment_config.institution_id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        default=uuid.UUID("00000000-0000-0000-0000-000000000001"),
    )
    client_session_uuid: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        unique=True,
        nullable=False,
        index=True,
    )
    teaching_assignment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("teaching_assignments.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    timetable_entry_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("timetable_entries.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    session_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
        index=True,
    )
    period_slot_or_sequence: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=1,
    )
    applicability_status: Mapped[SessionApplicability] = mapped_column(
        SQLEnum(SessionApplicability, name="session_applicability", native_enum=False),
        nullable=False,
        default=SessionApplicability.COUNTED,
    )
    status_reason: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
    )
    regular_faculty_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    conducting_faculty_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    substitute_delegation_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("substitute_delegations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    delegation_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
        index=True,
    )
    authorizing_role_assignment_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
        index=True,
    )
    finalizing_actor_membership_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
        index=True,
    )
    permission_code: Mapped[Optional[str]] = mapped_column(
        String(128),
        nullable=True,
    )
    matched_scope_type: Mapped[Optional[str]] = mapped_column(
        String(32),
        nullable=True,
    )
    matched_scope_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
    )
    session_status: Mapped[AttendanceSessionStatus] = mapped_column(
        SQLEnum(AttendanceSessionStatus, name="attendance_session_status", native_enum=False),
        nullable=False,
        default=AttendanceSessionStatus.FINALIZED,
    )
    finalized_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    payload_hash: Mapped[Optional[str]] = mapped_column(
        String(64),
        nullable=True,
        index=True,
    )
    records_count: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=0,
    )
    present_count: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=0,
    )
    absent_count: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=0,
    )
    excused_count: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=0,
    )

    teaching_assignment = relationship("TeachingAssignment")
    timetable_entry = relationship("TimetableEntry", back_populates="attendance_sessions")
    regular_faculty = relationship("User", foreign_keys=[regular_faculty_user_id])
    conducting_faculty = relationship("User", foreign_keys=[conducting_faculty_user_id])
    substitute_delegation = relationship("SubstituteDelegation", foreign_keys=[substitute_delegation_id])
    records: Mapped[List["AttendanceRecord"]] = relationship(
        "AttendanceRecord",
        back_populates="attendance_session",
        passive_deletes="all",
    )
    amendments: Mapped[List["AttendanceAmendmentAudit"]] = relationship(
        "AttendanceAmendmentAudit",
        back_populates="attendance_session",
        passive_deletes="all",
    )

    def __repr__(self) -> str:
        return (
            f"<AttendanceSession {self.id} (Client: {self.client_session_uuid}) "
            f"Assignment: {self.teaching_assignment_id} Date: {self.session_date} Slot: {self.period_slot_or_sequence}>"
        )


class AttendanceRecord(Base, TimestampMixin):
    __tablename__ = "attendance_records"
    __table_args__ = (
        UniqueConstraint("attendance_session_id", "student_user_id", name="uq_session_student_record"),
        Index("ix_attendance_records_student_session", "student_user_id", "attendance_session_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("deployment_config.institution_id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        default=uuid.UUID("00000000-0000-0000-0000-000000000001"),
    )
    attendance_session_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("attendance_sessions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    student_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    attendance_status: Mapped[AttendanceStatus] = mapped_column(
        SQLEnum(AttendanceStatus, name="attendance_status", native_enum=False),
        nullable=False,
    )
    mark_source: Mapped[MarkSource] = mapped_column(
        SQLEnum(MarkSource, name="mark_source", native_enum=False),
        nullable=False,
        default=MarkSource.MANUAL_MARK,
    )
    candidate_confidence: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
    )
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    attendance_session: Mapped["AttendanceSession"] = relationship(
        "AttendanceSession",
        back_populates="records",
    )
    student_user = relationship("User", foreign_keys=[student_user_id])

    def __repr__(self) -> str:
        return (
            f"<AttendanceRecord {self.id} Session: {self.attendance_session_id} "
            f"Student: {self.student_user_id} Status: {self.attendance_status}>"
        )


class AttendanceAmendmentAudit(Base, TimestampMixin):
    __tablename__ = "attendance_amendment_audits"
    __table_args__ = (
        CheckConstraint("new_status != previous_status", name="ck_amendment_status_changed"),
        CheckConstraint("length(amendment_reason) >= 10", name="ck_amendment_reason_length"),
        Index("ix_attendance_amendment_audits_session_id", "attendance_session_id"),
        Index("ix_attendance_amendment_audits_student_id", "student_user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("deployment_config.institution_id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        default=uuid.UUID("00000000-0000-0000-0000-000000000001"),
    )
    client_amendment_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
        unique=True,
        index=True,
    )
    attendance_session_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("attendance_sessions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    student_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    previous_status: Mapped[AttendanceStatus] = mapped_column(
        SQLEnum(AttendanceStatus, name="amendment_prev_status", native_enum=False),
        nullable=False,
    )
    new_status: Mapped[AttendanceStatus] = mapped_column(
        SQLEnum(AttendanceStatus, name="amendment_new_status", native_enum=False),
        nullable=False,
    )
    amending_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    amendment_role: Mapped[Optional[AmendmentRole]] = mapped_column(
        SQLEnum(AmendmentRole, name="amendment_role", native_enum=False),
        nullable=True,
    )
    actor_membership_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
        index=True,
    )
    authorizing_role_assignment_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
        index=True,
    )
    delegation_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
        index=True,
    )
    permission_code: Mapped[Optional[str]] = mapped_column(
        String(128),
        nullable=True,
    )
    scope_type: Mapped[Optional[str]] = mapped_column(
        String(32),
        nullable=True,
    )
    scope_resource_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
    )
    amendment_reason: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )
    amended_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    attendance_session: Mapped["AttendanceSession"] = relationship(
        "AttendanceSession",
        back_populates="amendments",
    )
    student_user = relationship("User", foreign_keys=[student_user_id])
    amending_user = relationship("User", foreign_keys=[amending_user_id])

    def __repr__(self) -> str:
        return (
            f"<AttendanceAmendmentAudit {self.id} Session: {self.attendance_session_id} "
            f"Student: {self.student_user_id} {self.previous_status} -> {self.new_status}>"
        )


class StudentAttendanceRequest(Base, TimestampMixin):
    __tablename__ = "student_attendance_requests"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("deployment_config.institution_id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        default=uuid.UUID("00000000-0000-0000-0000-000000000001"),
    )
    attendance_session_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("attendance_sessions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    student_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    teaching_assignment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("teaching_assignments.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    session_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )
    student_note: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )
    status: Mapped[AttendanceRequestStatus] = mapped_column(
        SQLEnum(AttendanceRequestStatus, name="attendance_request_status", native_enum=False),
        nullable=False,
        default=AttendanceRequestStatus.PENDING,
        index=True,
    )
    reviewer_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    resolution_note: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
    )
    resolved_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    student_user = relationship("User", foreign_keys=[student_user_id])
    reviewer_user = relationship("User", foreign_keys=[reviewer_user_id])
    teaching_assignment = relationship("TeachingAssignment")
    attendance_session = relationship("AttendanceSession", foreign_keys=[attendance_session_id])

    def __repr__(self) -> str:
        return f"<StudentAttendanceRequest {self.id} Student: {self.student_user_id} Status: {self.status}>"

