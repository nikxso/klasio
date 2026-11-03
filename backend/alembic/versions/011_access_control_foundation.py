"""access_control_foundation

Revision ID: 011_access_control_foundation
Revises: 010_student_attendance_requests
Create Date: 2026-11-01 12:00:00.000000+00:00

"""
from typing import Sequence, Union
import uuid
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "011_access_control_foundation"
down_revision: Union[str, None] = "010_student_attendance_requests"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Deterministic default IDs for single-tenant backfill
DEFAULT_INSTITUTION_ID = "00000000-0000-0000-0000-000000000001"
DEFAULT_CAMPUS_ID = "00000000-0000-0000-0000-000000000002"


def upgrade() -> None:
    # 1. Create Core Access Control Tables
    op.create_table(
        "institutions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="ACTIVE"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("ix_institutions_code", "institutions", ["code"], unique=True)

    op.create_table(
        "campuses",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("institution_id", sa.Uuid(), sa.ForeignKey("institutions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="ACTIVE"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("institution_id", "code", name="uq_campus_institution_code"),
    )
    op.create_index("ix_campuses_institution_id", "campuses", ["institution_id"])

    # 2. Insert Default Single-Tenant Institution and Campus for backfill
    op.execute(
        f"""
        INSERT INTO institutions (id, code, name, status, created_at, updated_at)
        VALUES ('{DEFAULT_INSTITUTION_ID}', 'KLASIO_MAIN', 'Klasio Institute of Technology', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (code) DO NOTHING
        """
    )
    op.execute(
        f"""
        INSERT INTO campuses (id, institution_id, code, name, status, created_at, updated_at)
        VALUES ('{DEFAULT_CAMPUS_ID}', '{DEFAULT_INSTITUTION_ID}', 'MAIN', 'Main Campus', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (institution_id, code) DO NOTHING
        """
    )

    # 3. Create Department-Campus Many-to-Many Association
    op.create_table(
        "department_campuses",
        sa.Column("department_id", sa.Uuid(), sa.ForeignKey("departments.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("campus_id", sa.Uuid(), sa.ForeignKey("campuses.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )

    # 4. Add Tenant Ownership to Existing Academic Models & Backfill
    # 4a. departments
    op.add_column("departments", sa.Column("institution_id", sa.Uuid(), server_default=sa.text(f"'{DEFAULT_INSTITUTION_ID}'"), nullable=True))
    op.execute(f"UPDATE departments SET institution_id = '{DEFAULT_INSTITUTION_ID}' WHERE institution_id IS NULL")
    op.alter_column("departments", "institution_id", nullable=False)
    op.create_foreign_key("fk_departments_institution_id", "departments", "institutions", ["institution_id"], ["id"], ondelete="CASCADE")
    op.create_index("ix_departments_institution_id", "departments", ["institution_id"])
    op.drop_index("ix_departments_code", table_name="departments")
    op.create_index("ix_departments_code", "departments", ["code"])
    op.create_unique_constraint("uq_department_institution_code", "departments", ["institution_id", "code"])

    # Link all existing departments to default campus
    op.execute(
        f"""
        INSERT INTO department_campuses (department_id, campus_id, created_at)
        SELECT id, '{DEFAULT_CAMPUS_ID}', CURRENT_TIMESTAMP FROM departments
        ON CONFLICT DO NOTHING
        """
    )

    # 4b. academic_terms
    op.add_column("academic_terms", sa.Column("institution_id", sa.Uuid(), server_default=sa.text(f"'{DEFAULT_INSTITUTION_ID}'"), nullable=True))
    op.execute(f"UPDATE academic_terms SET institution_id = '{DEFAULT_INSTITUTION_ID}' WHERE institution_id IS NULL")
    op.alter_column("academic_terms", "institution_id", nullable=False)
    op.create_foreign_key("fk_academic_terms_institution_id", "academic_terms", "institutions", ["institution_id"], ["id"], ondelete="CASCADE")
    op.create_index("ix_academic_terms_institution_id", "academic_terms", ["institution_id"])
    op.drop_index("ix_academic_terms_code", table_name="academic_terms")
    op.create_index("ix_academic_terms_code", "academic_terms", ["code"])
    op.create_unique_constraint("uq_term_institution_code", "academic_terms", ["institution_id", "code"])

    # 4c. subjects
    op.add_column("subjects", sa.Column("institution_id", sa.Uuid(), server_default=sa.text(f"'{DEFAULT_INSTITUTION_ID}'"), nullable=True))
    op.execute(f"UPDATE subjects SET institution_id = '{DEFAULT_INSTITUTION_ID}' WHERE institution_id IS NULL")
    op.alter_column("subjects", "institution_id", nullable=False)
    op.create_foreign_key("fk_subjects_institution_id", "subjects", "institutions", ["institution_id"], ["id"], ondelete="CASCADE")
    op.create_index("ix_subjects_institution_id", "subjects", ["institution_id"])
    op.drop_index("ix_subjects_code", table_name="subjects")
    op.create_index("ix_subjects_code", "subjects", ["code"])
    op.create_unique_constraint("uq_subject_institution_code", "subjects", ["institution_id", "code"])

    # 4d. class_sections
    op.add_column("class_sections", sa.Column("institution_id", sa.Uuid(), server_default=sa.text(f"'{DEFAULT_INSTITUTION_ID}'"), nullable=True))
    op.add_column("class_sections", sa.Column("campus_id", sa.Uuid(), server_default=sa.text(f"'{DEFAULT_CAMPUS_ID}'"), nullable=True))
    op.execute(
        f"""
        UPDATE class_sections
        SET institution_id = '{DEFAULT_INSTITUTION_ID}', campus_id = '{DEFAULT_CAMPUS_ID}'
        WHERE institution_id IS NULL
        """
    )
    op.alter_column("class_sections", "institution_id", nullable=False)
    op.alter_column("class_sections", "campus_id", nullable=False)
    op.create_foreign_key("fk_class_sections_institution_id", "class_sections", "institutions", ["institution_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("fk_class_sections_campus_id", "class_sections", "campuses", ["campus_id"], ["id"], ondelete="CASCADE")
    op.create_index("ix_class_sections_institution_campus", "class_sections", ["institution_id", "campus_id"])

    # 5. Create Institution Memberships
    op.create_table(
        "institution_memberships",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("institution_id", sa.Uuid(), sa.ForeignKey("institutions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="ACTIVE"),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("institution_id", "user_id", name="uq_membership_institution_user"),
    )
    op.create_index("ix_membership_user_status", "institution_memberships", ["user_id", "status"])
    op.create_index("ix_institution_memberships_institution_id", "institution_memberships", ["institution_id"])

    # Backfill memberships for all existing users into default institution (without role assignments!)
    op.execute(
        f"""
        INSERT INTO institution_memberships (id, institution_id, user_id, status, joined_at, created_at, updated_at)
        SELECT gen_random_uuid(), '{DEFAULT_INSTITUTION_ID}', id, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM users
        ON CONFLICT (institution_id, user_id) DO NOTHING
        """
    )

    # 6. Create Roles & Permissions Tables
    op.create_table(
        "role_templates",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_system_defined", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("ix_role_templates_code", "role_templates", ["code"], unique=True)

    op.create_table(
        "permissions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("code", sa.String(length=128), nullable=False),
        sa.Column("resource", sa.String(length=64), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_sensitive", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("ix_permissions_code", "permissions", ["code"], unique=True)
    op.create_index("ix_permissions_resource", "permissions", ["resource"])

    op.create_table(
        "role_permissions",
        sa.Column("role_template_id", sa.Uuid(), sa.ForeignKey("role_templates.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("permission_id", sa.Uuid(), sa.ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )

    # 7. Create Role Assignments and Scopes
    op.create_table(
        "role_assignments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("membership_id", sa.Uuid(), sa.ForeignKey("institution_memberships.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role_template_id", sa.Uuid(), sa.ForeignKey("role_templates.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="ACTIVE"),
        sa.Column("valid_from", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("granted_by_membership_id", sa.Uuid(), sa.ForeignKey("institution_memberships.id", ondelete="SET NULL"), nullable=True),
        sa.Column("approved_by_membership_id", sa.Uuid(), sa.ForeignKey("institution_memberships.id", ondelete="SET NULL"), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint("valid_until IS NULL OR valid_until > valid_from", name="chk_role_assignment_validity"),
    )
    op.create_index("ix_role_assignments_membership_status", "role_assignments", ["membership_id", "status"])

    scope_check_constraint = """
        (scope_type = 'INSTITUTION' AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
        (scope_type = 'CAMPUS' AND campus_id IS NOT NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
        (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL AND campus_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
        (scope_type = 'ACADEMIC_TERM' AND academic_term_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
        (scope_type = 'CLASS_SECTION' AND class_section_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND teaching_assignment_id IS NULL AND student_user_id IS NULL) OR
        (scope_type = 'TEACHING_ASSIGNMENT' AND teaching_assignment_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND student_user_id IS NULL) OR
        (scope_type = 'STUDENT' AND student_user_id IS NOT NULL AND campus_id IS NULL AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL AND teaching_assignment_id IS NULL)
    """

    op.create_table(
        "role_assignment_scopes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("role_assignment_id", sa.Uuid(), sa.ForeignKey("role_assignments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("institution_id", sa.Uuid(), sa.ForeignKey("institutions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("scope_type", sa.String(length=32), nullable=False),
        sa.Column("campus_id", sa.Uuid(), sa.ForeignKey("campuses.id", ondelete="CASCADE"), nullable=True),
        sa.Column("department_id", sa.Uuid(), sa.ForeignKey("departments.id", ondelete="CASCADE"), nullable=True),
        sa.Column("academic_term_id", sa.Uuid(), sa.ForeignKey("academic_terms.id", ondelete="CASCADE"), nullable=True),
        sa.Column("class_section_id", sa.Uuid(), sa.ForeignKey("class_sections.id", ondelete="CASCADE"), nullable=True),
        sa.Column("teaching_assignment_id", sa.Uuid(), sa.ForeignKey("teaching_assignments.id", ondelete="CASCADE"), nullable=True),
        sa.Column("student_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint(scope_check_constraint, name="chk_role_scope_resource_consistency"),
    )
    op.create_index("ix_role_assignment_scope_assignment_type", "role_assignment_scopes", ["role_assignment_id", "scope_type"])

    # 8. Create Delegations Tables
    op.create_table(
        "delegations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("grantor_role_assignment_id", sa.Uuid(), sa.ForeignKey("role_assignments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("grantee_membership_id", sa.Uuid(), sa.ForeignKey("institution_memberships.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="ACTIVE"),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("approved_by_membership_id", sa.Uuid(), sa.ForeignKey("institution_memberships.id", ondelete="SET NULL"), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by_membership_id", sa.Uuid(), sa.ForeignKey("institution_memberships.id", ondelete="SET NULL"), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revocation_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint("valid_until > valid_from", name="chk_delegation_validity"),
    )
    op.create_index("ix_delegations_grantee_status", "delegations", ["grantee_membership_id", "status"])
    op.create_index("ix_delegations_grantor_status", "delegations", ["grantor_role_assignment_id", "status"])

    op.create_table(
        "delegation_permissions",
        sa.Column("delegation_id", sa.Uuid(), sa.ForeignKey("delegations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("permission_id", sa.Uuid(), sa.ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )

    op.create_table(
        "delegation_scopes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("delegation_id", sa.Uuid(), sa.ForeignKey("delegations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("institution_id", sa.Uuid(), sa.ForeignKey("institutions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("scope_type", sa.String(length=32), nullable=False),
        sa.Column("campus_id", sa.Uuid(), sa.ForeignKey("campuses.id", ondelete="CASCADE"), nullable=True),
        sa.Column("department_id", sa.Uuid(), sa.ForeignKey("departments.id", ondelete="CASCADE"), nullable=True),
        sa.Column("academic_term_id", sa.Uuid(), sa.ForeignKey("academic_terms.id", ondelete="CASCADE"), nullable=True),
        sa.Column("class_section_id", sa.Uuid(), sa.ForeignKey("class_sections.id", ondelete="CASCADE"), nullable=True),
        sa.Column("teaching_assignment_id", sa.Uuid(), sa.ForeignKey("teaching_assignments.id", ondelete="CASCADE"), nullable=True),
        sa.Column("student_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint(scope_check_constraint, name="chk_delegation_scope_resource_consistency"),
    )

    # 9. Create Authorization Audits Table
    op.create_table(
        "authorization_audits",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("actor_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("actor_membership_id", sa.Uuid(), sa.ForeignKey("institution_memberships.id", ondelete="SET NULL"), nullable=True),
        sa.Column("institution_id", sa.Uuid(), sa.ForeignKey("institutions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("action", sa.String(length=128), nullable=False),
        sa.Column("permission_code", sa.String(length=128), nullable=True),
        sa.Column("target_resource_type", sa.String(length=64), nullable=True),
        sa.Column("target_resource_id", sa.String(length=64), nullable=True),
        sa.Column("outcome", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("correlation_id", sa.String(length=64), nullable=True),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("ix_auth_audits_institution_action", "authorization_audits", ["institution_id", "action"])
    op.create_index("ix_auth_audits_actor", "authorization_audits", ["actor_user_id", "created_at"])


def downgrade() -> None:
    # Drop authorization tables
    op.drop_table("authorization_audits")
    op.drop_table("delegation_scopes")
    op.drop_table("delegation_permissions")
    op.drop_table("delegations")
    op.drop_table("role_assignment_scopes")
    op.drop_table("role_assignments")
    op.drop_table("role_permissions")
    op.drop_table("permissions")
    op.drop_table("role_templates")
    op.drop_table("institution_memberships")

    # Revert academic tables tenant constraints
    op.drop_constraint("uq_department_institution_code", "departments", type_="unique")
    op.drop_constraint("fk_departments_institution_id", "departments", type_="foreignkey")
    op.drop_index("ix_departments_institution_id", table_name="departments")
    op.drop_column("departments", "institution_id")
    op.drop_index("ix_departments_code", table_name="departments")
    op.create_index("ix_departments_code", "departments", ["code"], unique=True)

    op.drop_constraint("uq_term_institution_code", "academic_terms", type_="unique")
    op.drop_constraint("fk_academic_terms_institution_id", "academic_terms", type_="foreignkey")
    op.drop_index("ix_academic_terms_institution_id", table_name="academic_terms")
    op.drop_column("academic_terms", "institution_id")
    op.drop_index("ix_academic_terms_code", table_name="academic_terms")
    op.create_index("ix_academic_terms_code", "academic_terms", ["code"], unique=True)

    op.drop_constraint("uq_subject_institution_code", "subjects", type_="unique")
    op.drop_constraint("fk_subjects_institution_id", "subjects", type_="foreignkey")
    op.drop_index("ix_subjects_institution_id", table_name="subjects")
    op.drop_column("subjects", "institution_id")
    op.drop_index("ix_subjects_code", table_name="subjects")
    op.create_index("ix_subjects_code", "subjects", ["code"], unique=True)

    op.drop_index("ix_class_sections_institution_campus", table_name="class_sections")
    op.drop_constraint("fk_class_sections_campus_id", "class_sections", type_="foreignkey")
    op.drop_constraint("fk_class_sections_institution_id", "class_sections", type_="foreignkey")
    op.drop_column("class_sections", "campus_id")
    op.drop_column("class_sections", "institution_id")

    op.drop_table("department_campuses")
    op.drop_table("campuses")
    op.drop_table("institutions")
