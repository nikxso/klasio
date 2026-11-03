from datetime import date, datetime
import enum
from typing import Optional
import uuid
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum as SQLEnum,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base, TimestampMixin


class DelegationStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"
    REVOKED = "REVOKED"


class TeachingAssignment(Base, TimestampMixin):
    __tablename__ = "teaching_assignments"
    __table_args__ = (
        UniqueConstraint("class_section_id", "subject_id", "academic_term_id", name="uq_section_subject_term"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    faculty_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    class_section_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("class_sections.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    subject_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("subjects.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    academic_term_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("academic_terms.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )

    faculty_user = relationship("User", foreign_keys=[faculty_user_id])
    created_by_user = relationship("User", foreign_keys=[created_by_user_id])
    class_section = relationship("ClassSection", back_populates="teaching_assignments")
    subject = relationship("Subject", back_populates="teaching_assignments")
    academic_term = relationship("AcademicTerm", back_populates="teaching_assignments")
    delegations = relationship("SubstituteDelegation", back_populates="teaching_assignment", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return f"<TeachingAssignment {self.id} Faculty: {self.faculty_user_id} Section: {self.class_section_id}>"


class SubstituteDelegation(Base, TimestampMixin):
    __tablename__ = "substitute_delegations"
    __table_args__ = (
        CheckConstraint("end_date >= start_date", name="chk_delegation_date_range"),
        CheckConstraint(
            "substitute_faculty_user_id != regular_faculty_user_id",
            name="chk_delegation_no_self",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    teaching_assignment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("teaching_assignments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    regular_faculty_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    substitute_faculty_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    start_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )
    end_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )
    delegation_reason: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )
    status: Mapped[DelegationStatus] = mapped_column(
        SQLEnum(DelegationStatus, name="delegation_status", native_enum=False),
        nullable=False,
        default=DelegationStatus.ACTIVE,
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    revoked_by_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    revoked_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    revocation_reason: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
    )

    teaching_assignment = relationship("TeachingAssignment", back_populates="delegations")
    regular_faculty = relationship("User", foreign_keys=[regular_faculty_user_id])
    substitute_faculty = relationship("User", foreign_keys=[substitute_faculty_user_id])
    created_by = relationship("User", foreign_keys=[created_by_user_id])
    revoked_by = relationship("User", foreign_keys=[revoked_by_user_id])

    def __repr__(self) -> str:
        return f"<SubstituteDelegation {self.id} Sub: {self.substitute_faculty_user_id} Status: {self.status}>"
