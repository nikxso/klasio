import enum
from typing import Optional
import uuid
from datetime import date
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    Enum as SQLEnum,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    SmallInteger,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship, foreign

from src.models.base import Base, TimestampMixin

# Default legacy tenant identifiers for backward compatibility
DEFAULT_INSTITUTION_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")
DEFAULT_CAMPUS_ID = uuid.UUID("00000000-0000-0000-0000-000000000002")


class DeploymentConfig(Base, TimestampMixin):
    __tablename__ = "deployment_config"
    __table_args__ = (
        CheckConstraint("singleton_id = 1", name="chk_deployment_config_singleton"),
        CheckConstraint(
            "deployment_mode = 'SINGLE_INSTITUTION_SELF_HOSTED'",
            name="chk_deployment_config_mode",
        ),
        CheckConstraint(
            "attendance_shortage_threshold >= 0.0 AND attendance_shortage_threshold <= 100.0",
            name="chk_deployment_config_threshold",
        ),
        UniqueConstraint("institution_id", name="uq_deployment_config_institution"),
    )

    singleton_id: Mapped[int] = mapped_column(
        SmallInteger,
        primary_key=True,
        default=1,
        server_default=text("1"),
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )
    deployment_mode: Mapped[str] = mapped_column(
        String(40),
        nullable=False,
        default="SINGLE_INSTITUTION_SELF_HOSTED",
        server_default=text("'SINGLE_INSTITUTION_SELF_HOSTED'"),
    )
    attendance_shortage_threshold: Mapped[float] = mapped_column(
        SmallInteger,
        nullable=False,
        default=75,
        server_default=text("75.0"),
    )

    institution = relationship("Institution")

    def __repr__(self) -> str:
        return f"<DeploymentConfig Inst: {self.institution_id} Mode: {self.deployment_mode}>"


class Program(Base, TimestampMixin):
    __tablename__ = "programs"
    __table_args__ = (
        UniqueConstraint("institution_id", "id", name="uq_programs_institution_id"),
        UniqueConstraint("institution_id", "department_id", "code", name="uq_programs_department_code"),
        UniqueConstraint("institution_id", "department_id", "id", name="uq_programs_institution_department_id"),
        ForeignKeyConstraint(
            ["institution_id"],
            ["deployment_config.institution_id"],
            name="fk_programs_deployment_institution",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["institution_id", "department_id"],
            ["departments.institution_id", "departments.id"],
            name="fk_programs_department",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
        index=True,
        default=DEFAULT_INSTITUTION_ID,
        server_default=text("'00000000-0000-0000-0000-000000000001'"),
    )
    department_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
        index=True,
    )
    code: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default=text("true"),
    )

    department = relationship("Department", foreign_keys=[institution_id, department_id])

    def __repr__(self) -> str:
        return f"<Program {self.code}: {self.name} (Dept: {self.department_id})>"


class TermStatus(str, enum.Enum):
    UPCOMING = "UPCOMING"
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    ARCHIVED = "ARCHIVED"


class Department(Base, TimestampMixin):
    __tablename__ = "departments"
    __table_args__ = (
        UniqueConstraint("institution_id", "code", name="uq_department_institution_code"),
        UniqueConstraint("institution_id", "id", name="uq_departments_inst_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        default=DEFAULT_INSTITUTION_ID,
        server_default=text("'00000000-0000-0000-0000-000000000001'"),
    )
    code: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )

    institution = relationship("Institution", back_populates="departments")
    campuses = relationship(
        "Campus",
        secondary="department_campuses",
        primaryjoin="and_(Department.institution_id == foreign(department_campuses.c.institution_id), Department.id == foreign(department_campuses.c.department_id))",
        secondaryjoin="and_(foreign(department_campuses.c.institution_id) == Campus.institution_id, foreign(department_campuses.c.campus_id) == Campus.id)",
        back_populates="departments",
    )
    subjects = relationship("Subject", back_populates="department", passive_deletes="all")
    sections = relationship("ClassSection", back_populates="department", passive_deletes="all")

    def __repr__(self) -> str:
        return f"<Department {self.code}: {self.name} (Inst: {self.institution_id})>"


class AcademicTerm(Base, TimestampMixin):
    __tablename__ = "academic_terms"
    __table_args__ = (
        CheckConstraint("end_date >= start_date", name="chk_term_date_range"),
        UniqueConstraint("institution_id", "code", name="uq_term_institution_code"),
        UniqueConstraint("institution_id", "id", name="uq_academic_terms_inst_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        default=DEFAULT_INSTITUTION_ID,
        server_default=text("'00000000-0000-0000-0000-000000000001'"),
    )
    code: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )
    academic_year: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
    )
    start_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )
    end_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )
    status: Mapped[TermStatus] = mapped_column(
        SQLEnum(TermStatus, name="term_status", native_enum=False),
        nullable=False,
        default=TermStatus.UPCOMING,
    )

    institution = relationship("Institution", back_populates="academic_terms")
    sections = relationship("ClassSection", back_populates="academic_term", passive_deletes="all")
    teaching_assignments = relationship("TeachingAssignment", back_populates="academic_term", passive_deletes="all")

    def __repr__(self) -> str:
        return f"<AcademicTerm {self.code} ({self.status})>"


class Subject(Base, TimestampMixin):
    __tablename__ = "subjects"
    __table_args__ = (
        UniqueConstraint("institution_id", "code", name="uq_subject_institution_code"),
        UniqueConstraint("institution_id", "id", name="uq_subjects_inst_id"),
        ForeignKeyConstraint(
            ["institution_id", "department_id"],
            ["departments.institution_id", "departments.id"],
            name="fk_subjects_inst_department",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        default=DEFAULT_INSTITUTION_ID,
        server_default=text("'00000000-0000-0000-0000-000000000001'"),
    )
    code: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )
    department_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
        index=True,
    )
    credits: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=3,
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
    )

    institution = relationship("Institution", back_populates="subjects", foreign_keys=[institution_id])
    department = relationship("Department", back_populates="subjects", foreign_keys=[institution_id, department_id])
    teaching_assignments = relationship("TeachingAssignment", back_populates="subject", passive_deletes="all")

    def __repr__(self) -> str:
        return f"<Subject {self.code}: {self.name}>"


class ClassSection(Base, TimestampMixin):
    __tablename__ = "class_sections"
    __table_args__ = (
        UniqueConstraint("academic_term_id", "section_code", name="uq_term_section_code"),
        UniqueConstraint("institution_id", "id", name="uq_class_sections_inst_id"),
        Index("ix_class_sections_institution_campus", "institution_id", "campus_id"),
        ForeignKeyConstraint(
            ["institution_id", "campus_id"],
            ["campuses.institution_id", "campuses.id"],
            name="fk_class_sections_inst_campus",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["institution_id", "department_id"],
            ["departments.institution_id", "departments.id"],
            name="fk_class_sections_inst_department",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["institution_id", "academic_term_id"],
            ["academic_terms.institution_id", "academic_terms.id"],
            name="fk_class_sections_inst_term",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        default=DEFAULT_INSTITUTION_ID,
        server_default=text("'00000000-0000-0000-0000-000000000001'"),
    )
    campus_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
        index=True,
        default=DEFAULT_CAMPUS_ID,
        server_default=text("'00000000-0000-0000-0000-000000000002'"),
    )
    section_code: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
    )
    department_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
        index=True,
    )
    academic_term_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
        index=True,
    )
    cohort_year: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
    )
    program_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
        index=True,
    )

    institution = relationship("Institution", back_populates="sections", foreign_keys=[institution_id])
    campus = relationship("Campus", back_populates="sections", foreign_keys=[institution_id, campus_id])
    department = relationship("Department", back_populates="sections", foreign_keys=[institution_id, department_id])
    academic_term = relationship("AcademicTerm", back_populates="sections", foreign_keys=[institution_id, academic_term_id])
    program = relationship("Program", foreign_keys=[institution_id, department_id, program_id], primaryjoin="and_(ClassSection.institution_id == foreign(Program.institution_id), ClassSection.department_id == foreign(Program.department_id), ClassSection.program_id == foreign(Program.id))")
    teaching_assignments = relationship("TeachingAssignment", back_populates="class_section", passive_deletes="all")

    def __repr__(self) -> str:
        return f"<ClassSection {self.section_code} (Term {self.academic_term_id})>"
