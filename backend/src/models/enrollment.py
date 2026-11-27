from datetime import date, datetime
import enum
from typing import Optional
import uuid
from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Enum as SQLEnum,
    Float,
    ForeignKey,
    Index,
    LargeBinary,
    SmallInteger,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base, TimestampMixin


class FaceRegistrationStatus(str, enum.Enum):
    UNREGISTERED = "UNREGISTERED"
    PENDING = "PENDING"
    REGISTERED = "REGISTERED"
    VALIDATION_FAILED = "VALIDATION_FAILED"


class EnrollmentStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    TRANSFERRED = "TRANSFERRED"
    WITHDRAWN = "WITHDRAWN"
    COMPLETED = "COMPLETED"


class StudentEnrollment(Base, TimestampMixin):
    __tablename__ = "student_enrollments"
    __table_args__ = (
        CheckConstraint(
            "effective_end_date IS NULL OR effective_end_date >= effective_start_date",
            name="chk_enrollment_date_range",
        ),
        Index("ix_student_enrollments_student_section", "student_user_id", "class_section_id"),
        Index("ix_student_enrollments_section_start", "class_section_id", "effective_start_date"),
        Index(
            "uq_student_term_active_open",
            "student_user_id",
            "academic_term_id",
            unique=True,
            postgresql_where=text("effective_end_date IS NULL"),
            sqlite_where=text("effective_end_date IS NULL"),
        ),
        Index("ix_student_enrollments_student_status", "student_user_id", "enrollment_status"),
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
    student_user_id: Mapped[uuid.UUID] = mapped_column(
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
    academic_term_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("academic_terms.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    effective_start_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )
    effective_end_date: Mapped[date] = mapped_column(
        Date,
        nullable=True,
    )
    enrollment_status: Mapped[EnrollmentStatus] = mapped_column(
        SQLEnum(EnrollmentStatus, name="enrollment_status", native_enum=False),
        nullable=False,
        default=EnrollmentStatus.ACTIVE,
    )

    student_user = relationship("User", foreign_keys=[student_user_id])
    class_section = relationship("ClassSection")
    academic_term = relationship("AcademicTerm")

    def __repr__(self) -> str:
        return (
            f"<StudentEnrollment {self.id} Student: {self.student_user_id} "
            f"Section: {self.class_section_id} ({self.effective_start_date} to {self.effective_end_date})>"
        )


class StudentFaceProfile(Base, TimestampMixin):
    __tablename__ = "student_face_profiles"

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
    student_user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
        index=True,
    )
    registration_state: Mapped[FaceRegistrationStatus] = mapped_column(
        SQLEnum(FaceRegistrationStatus, name="face_registration_state", native_enum=False),
        nullable=False,
        default=FaceRegistrationStatus.UNREGISTERED,
    )
    active_model_version: Mapped[Optional[str]] = mapped_column(
        String(64),
        nullable=True,
    )
    embedding_dimension: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        nullable=True,
    )
    sample_count: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=0,
    )
    embedding_blob: Mapped[Optional[bytes]] = mapped_column(
        LargeBinary,
        nullable=True,
    )
    quality_score: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
    )
    last_validated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    student_user = relationship("User", foreign_keys=[student_user_id], back_populates="face_profile")

    def __repr__(self) -> str:
        return (
            f"<StudentFaceProfile {self.id} Student: {self.student_user_id} "
            f"State: {self.registration_state} Model: {self.active_model_version}>"
        )
