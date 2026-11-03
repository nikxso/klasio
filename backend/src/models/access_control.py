from datetime import datetime
import enum
from typing import List, Optional
import uuid
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Enum as SQLEnum,
    ForeignKey,
    Index,
    String,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base, TimestampMixin

DEFAULT_INSTITUTION_ID = "00000000-0000-0000-0000-000000000001"


class InstitutionStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    SUSPENDED = "SUSPENDED"
    ARCHIVED = "ARCHIVED"


class CampusStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    SUSPENDED = "SUSPENDED"
    ARCHIVED = "ARCHIVED"


class MembershipStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    SUSPENDED = "SUSPENDED"
    REVOKED = "REVOKED"


class AssignmentStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    SUSPENDED = "SUSPENDED"
    REVOKED = "REVOKED"
    EXPIRED = "EXPIRED"


class RoleScopeType(str, enum.Enum):
    INSTITUTION = "INSTITUTION"
    CAMPUS = "CAMPUS"
    DEPARTMENT = "DEPARTMENT"
    ACADEMIC_TERM = "ACADEMIC_TERM"
    CLASS_SECTION = "CLASS_SECTION"
    TEACHING_ASSIGNMENT = "TEACHING_ASSIGNMENT"
    STUDENT = "STUDENT"


class DelegationLifecycleStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    REVOKED = "REVOKED"
    EXPIRED = "EXPIRED"


class AuditOutcome(str, enum.Enum):
    ALLOWED = "ALLOWED"
    DENIED = "DENIED"
    ERROR = "ERROR"


# Association table for Department <-> Campus (Many-to-Many)
department_campuses = Table(
    "department_campuses",
    Base.metadata,
    Column("institution_id", Uuid(as_uuid=True), ForeignKey("institutions.id", ondelete="CASCADE"), default=uuid.UUID(DEFAULT_INSTITUTION_ID), server_default=text(f"'{DEFAULT_INSTITUTION_ID}'"), nullable=False),
    Column("department_id", Uuid(as_uuid=True), ForeignKey("departments.id", ondelete="CASCADE"), primary_key=True),
    Column("campus_id", Uuid(as_uuid=True), ForeignKey("campuses.id", ondelete="CASCADE"), primary_key=True),
    Column("created_at", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP"), nullable=False),
)

# Association table for RoleTemplate <-> Permission (Many-to-Many)
role_permissions = Table(
    "role_permissions",
    Base.metadata,
    Column("role_template_id", Uuid(as_uuid=True), ForeignKey("role_templates.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", Uuid(as_uuid=True), ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
    Column("created_at", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP"), nullable=False),
)

# Association table for Delegation <-> Permission (Many-to-Many)
delegation_permissions = Table(
    "delegation_permissions",
    Base.metadata,
    Column("delegation_id", Uuid(as_uuid=True), ForeignKey("delegations.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", Uuid(as_uuid=True), ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
    Column("created_at", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP"), nullable=False),
)


class Institution(Base, TimestampMixin):
    __tablename__ = "institutions"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    code: Mapped[str] = mapped_column(
        String(64),
        unique=True,
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )
    status: Mapped[InstitutionStatus] = mapped_column(
        SQLEnum(InstitutionStatus, name="institution_status", native_enum=False),
        nullable=False,
        default=InstitutionStatus.ACTIVE,
    )

    campuses = relationship("Campus", back_populates="institution", cascade="all, delete-orphan")
    memberships = relationship("InstitutionMembership", back_populates="institution", cascade="all, delete-orphan")
    departments = relationship("Department", back_populates="institution", cascade="all, delete-orphan")
    academic_terms = relationship("AcademicTerm", back_populates="institution", cascade="all, delete-orphan")
    subjects = relationship("Subject", back_populates="institution", cascade="all, delete-orphan")
    sections = relationship("ClassSection", back_populates="institution", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return f"<Institution {self.code}: {self.name}>"


class Campus(Base, TimestampMixin):
    __tablename__ = "campuses"
    __table_args__ = (
        UniqueConstraint("institution_id", "code", name="uq_campus_institution_code"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="CASCADE"),
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
    status: Mapped[CampusStatus] = mapped_column(
        SQLEnum(CampusStatus, name="campus_status", native_enum=False),
        nullable=False,
        default=CampusStatus.ACTIVE,
    )

    institution = relationship("Institution", back_populates="campuses")
    departments = relationship("Department", secondary=department_campuses, back_populates="campuses")
    sections = relationship("ClassSection", back_populates="campus")

    def __repr__(self) -> str:
        return f"<Campus {self.code}: {self.name} (Inst: {self.institution_id})>"


class InstitutionMembership(Base, TimestampMixin):
    __tablename__ = "institution_memberships"
    __table_args__ = (
        UniqueConstraint("institution_id", "user_id", name="uq_membership_institution_user"),
        Index("ix_membership_user_status", "user_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[MembershipStatus] = mapped_column(
        SQLEnum(MembershipStatus, name="membership_status", native_enum=False),
        nullable=False,
        default=MembershipStatus.ACTIVE,
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=datetime.utcnow,
    )

    institution = relationship("Institution", back_populates="memberships")
    user = relationship("User")
    role_assignments = relationship("RoleAssignment", back_populates="membership", foreign_keys="RoleAssignment.membership_id", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return f"<InstitutionMembership {self.id} User: {self.user_id} Inst: {self.institution_id} ({self.status})>"


class Permission(Base, TimestampMixin):
    __tablename__ = "permissions"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    code: Mapped[str] = mapped_column(
        String(128),
        unique=True,
        nullable=False,
        index=True,
    )
    resource: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        index=True,
    )
    action: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
    )
    description: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
    )
    is_sensitive: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
    )

    role_templates = relationship("RoleTemplate", secondary=role_permissions, back_populates="permissions")

    def __repr__(self) -> str:
        return f"<Permission {self.code}>"


class RoleTemplate(Base, TimestampMixin):
    __tablename__ = "role_templates"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    code: Mapped[str] = mapped_column(
        String(64),
        unique=True,
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )
    category: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
    )
    description: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
    )
    is_system_defined: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
    )

    permissions = relationship("Permission", secondary=role_permissions, back_populates="role_templates")
    assignments = relationship("RoleAssignment", back_populates="role_template")

    def __repr__(self) -> str:
        return f"<RoleTemplate {self.code}>"


class RoleAssignment(Base, TimestampMixin):
    __tablename__ = "role_assignments"
    __table_args__ = (
        CheckConstraint(
            "valid_until IS NULL OR valid_until > valid_from",
            name="chk_role_assignment_validity",
        ),
        Index("ix_role_assignments_membership_status", "membership_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        default=uuid.UUID(DEFAULT_INSTITUTION_ID),
        server_default=text(f"'{DEFAULT_INSTITUTION_ID}'"),
    )
    membership_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institution_memberships.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role_template_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("role_templates.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    status: Mapped[AssignmentStatus] = mapped_column(
        SQLEnum(AssignmentStatus, name="assignment_status", native_enum=False),
        nullable=False,
        default=AssignmentStatus.ACTIVE,
    )
    valid_from: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=datetime.utcnow,
    )
    valid_until: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    granted_by_membership_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institution_memberships.id", ondelete="SET NULL"),
        nullable=True,
    )
    approved_by_membership_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institution_memberships.id", ondelete="SET NULL"),
        nullable=True,
    )
    reason: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
    )

    membership = relationship("InstitutionMembership", foreign_keys=[membership_id], back_populates="role_assignments")
    role_template = relationship("RoleTemplate", back_populates="assignments")
    granted_by = relationship("InstitutionMembership", foreign_keys=[granted_by_membership_id])
    approved_by = relationship("InstitutionMembership", foreign_keys=[approved_by_membership_id])
    scopes = relationship("RoleAssignmentScope", back_populates="role_assignment", cascade="all, delete-orphan")
    granted_delegations = relationship("Delegation", back_populates="grantor_assignment", foreign_keys="Delegation.grantor_role_assignment_id")

    def __repr__(self) -> str:
        return f"<RoleAssignment {self.id} Role: {self.role_template_id} Status: {self.status}>"


class RoleAssignmentScope(Base, TimestampMixin):
    __tablename__ = "role_assignment_scopes"
    __table_args__ = (
        CheckConstraint(
            """
            (scope_type = 'INSTITUTION' AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'CAMPUS' AND campus_id IS NOT NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL AND campus_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'ACADEMIC_TERM' AND academic_term_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'CLASS_SECTION' AND class_section_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'TEACHING_ASSIGNMENT' AND teaching_assignment_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'STUDENT' AND student_user_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL)
            """,
            name="chk_role_scope_resource_consistency",
        ),
        Index("ix_role_assignment_scope_assignment_type", "role_assignment_id", "scope_type"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    role_assignment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("role_assignments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    scope_type: Mapped[RoleScopeType] = mapped_column(
        SQLEnum(RoleScopeType, name="role_scope_type", native_enum=False),
        nullable=False,
    )
    campus_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("campuses.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    department_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("departments.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    academic_term_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("academic_terms.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    class_section_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("class_sections.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    teaching_assignment_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("teaching_assignments.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    student_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )

    role_assignment = relationship("RoleAssignment", back_populates="scopes")
    institution = relationship("Institution")
    campus = relationship("Campus")
    department = relationship("Department")
    academic_term = relationship("AcademicTerm")
    class_section = relationship("ClassSection")
    teaching_assignment = relationship("TeachingAssignment")
    student_user = relationship("User")

    def __repr__(self) -> str:
        return f"<RoleAssignmentScope {self.id} Type: {self.scope_type} Assignment: {self.role_assignment_id}>"


class Delegation(Base, TimestampMixin):
    __tablename__ = "delegations"
    __table_args__ = (
        CheckConstraint(
            "valid_until > valid_from",
            name="chk_delegation_validity",
        ),
        Index("ix_delegations_grantee_status", "grantee_membership_id", "status"),
        Index("ix_delegations_grantor_status", "grantor_role_assignment_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        default=uuid.UUID(DEFAULT_INSTITUTION_ID),
        server_default=text(f"'{DEFAULT_INSTITUTION_ID}'"),
    )
    grantor_role_assignment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("role_assignments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    grantee_membership_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institution_memberships.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[DelegationLifecycleStatus] = mapped_column(
        SQLEnum(DelegationLifecycleStatus, name="delegation_lifecycle_status", native_enum=False),
        nullable=False,
        default=DelegationLifecycleStatus.ACTIVE,
    )
    valid_from: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    valid_until: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    reason: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )
    approved_by_membership_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institution_memberships.id", ondelete="SET NULL"),
        nullable=True,
    )
    approved_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    revoked_by_membership_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institution_memberships.id", ondelete="SET NULL"),
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

    grantor_assignment = relationship("RoleAssignment", back_populates="granted_delegations", foreign_keys=[grantor_role_assignment_id])
    grantee_membership = relationship("InstitutionMembership", foreign_keys=[grantee_membership_id])
    approved_by = relationship("InstitutionMembership", foreign_keys=[approved_by_membership_id])
    revoked_by = relationship("InstitutionMembership", foreign_keys=[revoked_by_membership_id])
    permissions = relationship("Permission", secondary=delegation_permissions)
    scopes = relationship("DelegationScope", back_populates="delegation", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return f"<Delegation {self.id} Grantee: {self.grantee_membership_id} Status: {self.status}>"


class DelegationScope(Base, TimestampMixin):
    __tablename__ = "delegation_scopes"
    __table_args__ = (
        CheckConstraint(
            """
            (scope_type = 'INSTITUTION' AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'CAMPUS' AND campus_id IS NOT NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL AND campus_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'ACADEMIC_TERM' AND academic_term_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'CLASS_SECTION' AND class_section_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'TEACHING_ASSIGNMENT' AND teaching_assignment_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND student_user_id IS NULL) OR
            (scope_type = 'STUDENT' AND student_user_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL)
            """,
            name="chk_delegation_scope_resource_consistency",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    delegation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("delegations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    scope_type: Mapped[RoleScopeType] = mapped_column(
        SQLEnum(RoleScopeType, name="delegation_scope_type", native_enum=False),
        nullable=False,
    )
    campus_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("campuses.id", ondelete="CASCADE"),
        nullable=True,
    )
    department_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("departments.id", ondelete="CASCADE"),
        nullable=True,
    )
    academic_term_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("academic_terms.id", ondelete="CASCADE"),
        nullable=True,
    )
    class_section_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("class_sections.id", ondelete="CASCADE"),
        nullable=True,
    )
    teaching_assignment_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("teaching_assignments.id", ondelete="CASCADE"),
        nullable=True,
    )
    student_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )

    delegation = relationship("Delegation", back_populates="scopes")
    institution = relationship("Institution")
    campus = relationship("Campus")
    department = relationship("Department")
    academic_term = relationship("AcademicTerm")
    class_section = relationship("ClassSection")
    teaching_assignment = relationship("TeachingAssignment")
    student_user = relationship("User")

    def __repr__(self) -> str:
        return f"<DelegationScope {self.id} Type: {self.scope_type} Delegation: {self.delegation_id}>"


class AuthorizationAudit(Base, TimestampMixin):
    __tablename__ = "authorization_audits"
    __table_args__ = (
        Index("ix_auth_audits_institution_action", "institution_id", "action"),
        Index("ix_auth_audits_actor", "actor_user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    actor_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    actor_membership_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institution_memberships.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    institution_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    action: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
    )
    permission_code: Mapped[Optional[str]] = mapped_column(
        String(128),
        nullable=True,
        index=True,
    )
    target_resource_type: Mapped[Optional[str]] = mapped_column(
        String(64),
        nullable=True,
    )
    target_resource_id: Mapped[Optional[str]] = mapped_column(
        String(64),
        nullable=True,
    )
    outcome: Mapped[AuditOutcome] = mapped_column(
        SQLEnum(AuditOutcome, name="audit_outcome", native_enum=False),
        nullable=False,
    )
    reason: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
    )
    correlation_id: Mapped[Optional[str]] = mapped_column(
        String(64),
        nullable=True,
        index=True,
    )
    ip_address: Mapped[Optional[str]] = mapped_column(
        String(64),
        nullable=True,
    )
    user_agent: Mapped[Optional[str]] = mapped_column(
        String(255),
        nullable=True,
    )

    actor_user = relationship("User", foreign_keys=[actor_user_id])
    actor_membership = relationship("InstitutionMembership", foreign_keys=[actor_membership_id])
    institution = relationship("Institution", foreign_keys=[institution_id])

    def __repr__(self) -> str:
        return f"<AuthorizationAudit {self.id} Action: {self.action} Outcome: {self.outcome}>"
