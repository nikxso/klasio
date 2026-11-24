"""target_schema_patch

Revision ID: 017_target_schema_patch
Revises: 016_notification_center
Create Date: 2026-11-25 00:00:00.000000+00:00

Implements the single-institution deployment architecture, Academic Programs,
institution-bound operational tables, ReBAC typed scopes, authorization provenance
on sessions/audits, and authority notification payloads.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "017_target_schema_patch"
down_revision: Union[str, None] = "016_notification_center"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEFAULT_INST_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    # -------------------------------------------------------------------------
    # 1. Deployment Config Singleton
    # -------------------------------------------------------------------------
    op.create_table(
        "deployment_config",
        sa.Column("singleton_id", sa.SmallInteger(), server_default=sa.text("1"), nullable=False),
        sa.Column("institution_id", sa.Uuid(), nullable=False),
        sa.Column(
            "deployment_mode",
            sa.String(length=40),
            server_default=sa.text("'SINGLE_INSTITUTION_SELF_HOSTED'"),
            nullable=False,
        ),
        sa.Column(
            "attendance_shortage_threshold",
            sa.Numeric(precision=4, scale=1),
            server_default=sa.text("75.0"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint("singleton_id = 1", name="chk_deployment_config_singleton"),
        sa.CheckConstraint(
            "deployment_mode = 'SINGLE_INSTITUTION_SELF_HOSTED'",
            name="chk_deployment_config_mode",
        ),
        sa.CheckConstraint(
            "attendance_shortage_threshold >= 0.0 AND attendance_shortage_threshold <= 100.0",
            name="chk_deployment_config_threshold",
        ),
        sa.ForeignKeyConstraint(
            ["institution_id"],
            ["institutions.id"],
            name="fk_deployment_config_institution",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("singleton_id"),
        sa.UniqueConstraint("institution_id", name="uq_deployment_config_institution"),
    )

    # Seed singleton row for existing institution
    op.execute(
        sa.text(
            f"INSERT INTO deployment_config (singleton_id, institution_id, deployment_mode, attendance_shortage_threshold) "
            f"VALUES (1, '{DEFAULT_INST_ID}', 'SINGLE_INSTITUTION_SELF_HOSTED', 75.0) "
            f"ON CONFLICT (singleton_id) DO NOTHING;"
        )
    )

    # -------------------------------------------------------------------------
    # 2. Academic Programs Table
    # -------------------------------------------------------------------------
    op.create_table(
        "programs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("institution_id", sa.Uuid(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(
            ["institution_id"],
            ["deployment_config.institution_id"],
            name="fk_programs_deployment_institution",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["institution_id", "department_id"],
            ["departments.institution_id", "departments.id"],
            name="fk_programs_department",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("institution_id", "id", name="uq_programs_institution_id"),
        sa.UniqueConstraint("institution_id", "department_id", "code", name="uq_programs_department_code"),
        sa.UniqueConstraint("institution_id", "department_id", "id", name="uq_programs_institution_department_id"),
    )
    op.create_index("ix_programs_department", "programs", ["institution_id", "department_id"])

    # -------------------------------------------------------------------------
    # 3. Class Sections: Program Association
    # -------------------------------------------------------------------------
    op.add_column("class_sections", sa.Column("program_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_class_sections_program_department",
        "class_sections",
        "programs",
        ["institution_id", "department_id", "program_id"],
        ["institution_id", "department_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_unique_constraint(
        "uq_class_sections_inst_id_term",
        "class_sections",
        ["institution_id", "id", "academic_term_id"],
    )

    # -------------------------------------------------------------------------
    # 4. Bind Operational Tables to Single Institution with Safe Backfills
    # -------------------------------------------------------------------------

    # 4a. teaching_assignments
    op.add_column("teaching_assignments", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE teaching_assignments ta "
            "SET institution_id = cs.institution_id "
            "FROM class_sections cs "
            "WHERE cs.id = ta.class_section_id AND ta.institution_id IS NULL;"
        )
    )
    op.execute(
        sa.text(
            f"UPDATE teaching_assignments SET institution_id = '{DEFAULT_INST_ID}' WHERE institution_id IS NULL;"
        )
    )
    op.alter_column("teaching_assignments", "institution_id", nullable=False)
    op.create_unique_constraint(
        "uq_teaching_assignments_inst_id",
        "teaching_assignments",
        ["institution_id", "id"],
    )
    op.create_foreign_key(
        "fk_teaching_assignment_deployment_institution",
        "teaching_assignments",
        "deployment_config",
        ["institution_id"],
        ["institution_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_teaching_assignment_section_term",
        "teaching_assignments",
        "class_sections",
        ["institution_id", "class_section_id", "academic_term_id"],
        ["institution_id", "id", "academic_term_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_teaching_assignment_faculty_membership",
        "teaching_assignments",
        "institution_memberships",
        ["institution_id", "faculty_user_id"],
        ["institution_id", "user_id"],
        ondelete="RESTRICT",
    )

    # 4b. student_enrollments
    op.add_column("student_enrollments", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE student_enrollments se "
            "SET institution_id = cs.institution_id "
            "FROM class_sections cs "
            "WHERE cs.id = se.class_section_id AND se.institution_id IS NULL;"
        )
    )
    op.execute(
        sa.text(
            f"UPDATE student_enrollments SET institution_id = '{DEFAULT_INST_ID}' WHERE institution_id IS NULL;"
        )
    )
    op.alter_column("student_enrollments", "institution_id", nullable=False)
    op.create_foreign_key(
        "fk_enrollment_deployment_institution",
        "student_enrollments",
        "deployment_config",
        ["institution_id"],
        ["institution_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_enrollment_section_term",
        "student_enrollments",
        "class_sections",
        ["institution_id", "class_section_id", "academic_term_id"],
        ["institution_id", "id", "academic_term_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_enrollment_student_membership",
        "student_enrollments",
        "institution_memberships",
        ["institution_id", "student_user_id"],
        ["institution_id", "user_id"],
        ondelete="RESTRICT",
    )

    # 4c. student_face_profiles
    op.add_column("student_face_profiles", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE student_face_profiles sfp "
            "SET institution_id = im.institution_id "
            "FROM institution_memberships im "
            "WHERE im.user_id = sfp.student_user_id AND sfp.institution_id IS NULL;"
        )
    )
    op.execute(
        sa.text(
            f"UPDATE student_face_profiles SET institution_id = '{DEFAULT_INST_ID}' WHERE institution_id IS NULL;"
        )
    )
    op.alter_column("student_face_profiles", "institution_id", nullable=False)
    op.create_foreign_key(
        "fk_face_profile_deployment_institution",
        "student_face_profiles",
        "deployment_config",
        ["institution_id"],
        ["institution_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_face_profile_student_membership",
        "student_face_profiles",
        "institution_memberships",
        ["institution_id", "student_user_id"],
        ["institution_id", "user_id"],
        ondelete="RESTRICT",
    )

    # 4d. attendance_sessions
    op.add_column("attendance_sessions", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE attendance_sessions s "
            "SET institution_id = ta.institution_id "
            "FROM teaching_assignments ta "
            "WHERE ta.id = s.teaching_assignment_id AND s.institution_id IS NULL;"
        )
    )
    op.execute(
        sa.text(
            f"UPDATE attendance_sessions SET institution_id = '{DEFAULT_INST_ID}' WHERE institution_id IS NULL;"
        )
    )
    op.alter_column("attendance_sessions", "institution_id", nullable=False)
    op.create_unique_constraint(
        "uq_attendance_sessions_inst_id",
        "attendance_sessions",
        ["institution_id", "id"],
    )
    op.create_foreign_key(
        "fk_attendance_session_deployment_institution",
        "attendance_sessions",
        "deployment_config",
        ["institution_id"],
        ["institution_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_attendance_session_assignment_institution",
        "attendance_sessions",
        "teaching_assignments",
        ["institution_id", "teaching_assignment_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )

    # 4e. attendance_records
    op.add_column("attendance_records", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE attendance_records ar "
            "SET institution_id = s.institution_id "
            "FROM attendance_sessions s "
            "WHERE s.id = ar.attendance_session_id AND ar.institution_id IS NULL;"
        )
    )
    op.execute(
        sa.text(
            f"UPDATE attendance_records SET institution_id = '{DEFAULT_INST_ID}' WHERE institution_id IS NULL;"
        )
    )
    op.alter_column("attendance_records", "institution_id", nullable=False)
    op.create_foreign_key(
        "fk_attendance_record_deployment_institution",
        "attendance_records",
        "deployment_config",
        ["institution_id"],
        ["institution_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_attendance_record_session_institution",
        "attendance_records",
        "attendance_sessions",
        ["institution_id", "attendance_session_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_attendance_record_student_membership",
        "attendance_records",
        "institution_memberships",
        ["institution_id", "student_user_id"],
        ["institution_id", "user_id"],
        ondelete="RESTRICT",
    )

    # 4f. attendance_amendment_audits
    op.add_column("attendance_amendment_audits", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE attendance_amendment_audits aa "
            "SET institution_id = s.institution_id "
            "FROM attendance_sessions s "
            "WHERE s.id = aa.attendance_session_id AND aa.institution_id IS NULL;"
        )
    )
    op.execute(
        sa.text(
            f"UPDATE attendance_amendment_audits SET institution_id = '{DEFAULT_INST_ID}' WHERE institution_id IS NULL;"
        )
    )
    op.alter_column("attendance_amendment_audits", "institution_id", nullable=False)
    op.create_foreign_key(
        "fk_amendment_deployment_institution",
        "attendance_amendment_audits",
        "deployment_config",
        ["institution_id"],
        ["institution_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_amendment_session_institution",
        "attendance_amendment_audits",
        "attendance_sessions",
        ["institution_id", "attendance_session_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )

    # 4g. student_attendance_requests
    op.add_column("student_attendance_requests", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.add_column("student_attendance_requests", sa.Column("attendance_session_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE student_attendance_requests sar "
            "SET institution_id = ta.institution_id "
            "FROM teaching_assignments ta "
            "WHERE ta.id = sar.teaching_assignment_id AND sar.institution_id IS NULL;"
        )
    )
    op.execute(
        sa.text(
            f"UPDATE student_attendance_requests SET institution_id = '{DEFAULT_INST_ID}' WHERE institution_id IS NULL;"
        )
    )
    op.alter_column("student_attendance_requests", "institution_id", nullable=False)
    op.create_foreign_key(
        "fk_student_request_deployment_institution",
        "student_attendance_requests",
        "deployment_config",
        ["institution_id"],
        ["institution_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_student_request_session",
        "student_attendance_requests",
        "attendance_sessions",
        ["attendance_session_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_student_request_assignment_institution",
        "student_attendance_requests",
        "teaching_assignments",
        ["institution_id", "teaching_assignment_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )

    # 4h. substitute_delegations (legacy table)
    op.add_column("substitute_delegations", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE substitute_delegations sd "
            "SET institution_id = ta.institution_id "
            "FROM teaching_assignments ta "
            "WHERE ta.id = sd.teaching_assignment_id AND sd.institution_id IS NULL;"
        )
    )
    op.execute(
        sa.text(
            f"UPDATE substitute_delegations SET institution_id = '{DEFAULT_INST_ID}' WHERE institution_id IS NULL;"
        )
    )
    op.alter_column("substitute_delegations", "institution_id", nullable=False)
    op.create_foreign_key(
        "fk_legacy_substitute_deployment_institution",
        "substitute_delegations",
        "deployment_config",
        ["institution_id"],
        ["institution_id"],
        ondelete="RESTRICT",
    )

    # 4i. report_export_audits
    op.add_column("report_export_audits", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE report_export_audits rea "
            "SET institution_id = ta.institution_id "
            "FROM teaching_assignments ta "
            "WHERE ta.id = rea.teaching_assignment_id AND rea.institution_id IS NULL;"
        )
    )
    op.execute(
        sa.text(
            f"UPDATE report_export_audits SET institution_id = '{DEFAULT_INST_ID}' WHERE institution_id IS NULL;"
        )
    )
    op.alter_column("report_export_audits", "institution_id", nullable=False)
    op.create_foreign_key(
        "fk_report_export_deployment_institution",
        "report_export_audits",
        "deployment_config",
        ["institution_id"],
        ["institution_id"],
        ondelete="RESTRICT",
    )

    # -------------------------------------------------------------------------
    # 5. Authorization Provenance Fields
    # -------------------------------------------------------------------------

    # 5a. attendance_sessions
    op.add_column("attendance_sessions", sa.Column("delegation_id", sa.Uuid(), nullable=True))
    op.add_column("attendance_sessions", sa.Column("authorizing_role_assignment_id", sa.Uuid(), nullable=True))
    op.add_column("attendance_sessions", sa.Column("finalizing_actor_membership_id", sa.Uuid(), nullable=True))
    op.add_column("attendance_sessions", sa.Column("permission_code", sa.String(length=128), nullable=True))
    op.add_column("attendance_sessions", sa.Column("matched_scope_type", sa.String(length=32), nullable=True))
    op.add_column("attendance_sessions", sa.Column("matched_scope_id", sa.Uuid(), nullable=True))

    op.create_foreign_key(
        "fk_attendance_session_delegation",
        "attendance_sessions",
        "delegations",
        ["institution_id", "delegation_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_attendance_session_authorizing_assignment",
        "attendance_sessions",
        "role_assignments",
        ["institution_id", "authorizing_role_assignment_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_attendance_session_finalizing_actor",
        "attendance_sessions",
        "institution_memberships",
        ["institution_id", "finalizing_actor_membership_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )

    # 5b. attendance_amendment_audits
    op.add_column("attendance_amendment_audits", sa.Column("actor_membership_id", sa.Uuid(), nullable=True))
    op.add_column("attendance_amendment_audits", sa.Column("authorizing_role_assignment_id", sa.Uuid(), nullable=True))
    op.add_column("attendance_amendment_audits", sa.Column("delegation_id", sa.Uuid(), nullable=True))
    op.add_column("attendance_amendment_audits", sa.Column("permission_code", sa.String(length=128), nullable=True))
    op.add_column("attendance_amendment_audits", sa.Column("scope_type", sa.String(length=32), nullable=True))
    op.add_column("attendance_amendment_audits", sa.Column("scope_resource_id", sa.Uuid(), nullable=True))

    op.execute(
        sa.text(
            "UPDATE attendance_amendment_audits aa "
            "SET actor_membership_id = im.id "
            "FROM institution_memberships im "
            "WHERE im.institution_id = aa.institution_id "
            "  AND im.user_id = aa.amending_user_id "
            "  AND aa.actor_membership_id IS NULL;"
        )
    )
    op.alter_column("attendance_amendment_audits", "amendment_role", nullable=True)

    op.create_foreign_key(
        "fk_amendment_actor_membership",
        "attendance_amendment_audits",
        "institution_memberships",
        ["institution_id", "actor_membership_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_amendment_authorizing_assignment",
        "attendance_amendment_audits",
        "role_assignments",
        ["institution_id", "authorizing_role_assignment_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_amendment_delegation",
        "attendance_amendment_audits",
        "delegations",
        ["institution_id", "delegation_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )

    # 5c. report_export_audits
    op.add_column("report_export_audits", sa.Column("actor_membership_id", sa.Uuid(), nullable=True))
    op.add_column("report_export_audits", sa.Column("authorizing_role_assignment_id", sa.Uuid(), nullable=True))
    op.add_column("report_export_audits", sa.Column("delegation_id", sa.Uuid(), nullable=True))
    op.add_column("report_export_audits", sa.Column("permission_code", sa.String(length=128), nullable=True))
    op.add_column("report_export_audits", sa.Column("scope_type", sa.String(length=32), nullable=True))
    op.add_column("report_export_audits", sa.Column("scope_resource_id", sa.Uuid(), nullable=True))

    op.execute(
        sa.text(
            "UPDATE report_export_audits rea "
            "SET actor_membership_id = im.id "
            "FROM institution_memberships im "
            "WHERE im.institution_id = rea.institution_id "
            "  AND im.user_id = rea.user_id "
            "  AND rea.actor_membership_id IS NULL;"
        )
    )
    op.alter_column("report_export_audits", "user_role", nullable=True)

    op.create_foreign_key(
        "fk_report_export_actor_membership",
        "report_export_audits",
        "institution_memberships",
        ["institution_id", "actor_membership_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_report_export_authorizing_assignment",
        "report_export_audits",
        "role_assignments",
        ["institution_id", "authorizing_role_assignment_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_report_export_delegation",
        "report_export_audits",
        "delegations",
        ["institution_id", "delegation_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )

    # -------------------------------------------------------------------------
    # 6. Delegations: Type Discriminator
    # -------------------------------------------------------------------------
    op.add_column("delegations", sa.Column("delegation_type", sa.String(length=32), server_default=sa.text("'FACULTY_SUBSTITUTE'"), nullable=False))
    op.create_check_constraint(
        "chk_delegation_type",
        "delegations",
        "delegation_type IN ('FACULTY_SUBSTITUTE', 'MANAGEMENT_DELEGATION')",
    )

    # -------------------------------------------------------------------------
    # 7. Scopes: Program Dimension & Consistency Constraints
    # -------------------------------------------------------------------------
    op.add_column("role_assignment_scopes", sa.Column("program_id", sa.Uuid(), nullable=True))
    op.add_column("delegation_scopes", sa.Column("program_id", sa.Uuid(), nullable=True))

    op.create_foreign_key(
        "fk_role_scope_program",
        "role_assignment_scopes",
        "programs",
        ["institution_id", "program_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_delegation_scope_program",
        "delegation_scopes",
        "programs",
        ["institution_id", "program_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )

    # Drop existing check constraint if any and add 8-level typed check
    op.execute(sa.text("ALTER TABLE role_assignment_scopes DROP CONSTRAINT IF EXISTS chk_role_scope_resource_consistency;"))
    op.create_check_constraint(
        "chk_role_scope_resource_consistency",
        "role_assignment_scopes",
        """
        (scope_type = 'INSTITUTION' AND campus_id IS NULL AND department_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'CAMPUS' AND campus_id IS NOT NULL AND department_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL AND campus_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'PROGRAM' AND program_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'ACADEMIC_TERM' AND academic_term_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'CLASS_SECTION' AND class_section_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND academic_term_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'TEACHING_ASSIGNMENT' AND teaching_assignment_id IS NOT NULL
         AND campus_id IS NULL AND department_id IS NULL AND program_id IS NULL
         AND academic_term_id IS NULL AND class_section_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'STUDENT' AND student_user_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND academic_term_id IS NULL
         AND class_section_id IS NULL AND teaching_assignment_id IS NULL)
        """,
    )

    op.execute(sa.text("ALTER TABLE delegation_scopes DROP CONSTRAINT IF EXISTS chk_delegation_scope_resource_consistency;"))
    op.create_check_constraint(
        "chk_delegation_scope_resource_consistency",
        "delegation_scopes",
        """
        (scope_type = 'INSTITUTION' AND campus_id IS NULL AND department_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'CAMPUS' AND campus_id IS NOT NULL AND department_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL AND campus_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'PROGRAM' AND program_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'ACADEMIC_TERM' AND academic_term_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'CLASS_SECTION' AND class_section_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND academic_term_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'TEACHING_ASSIGNMENT' AND teaching_assignment_id IS NOT NULL
         AND campus_id IS NULL AND department_id IS NULL AND program_id IS NULL
         AND academic_term_id IS NULL AND class_section_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'STUDENT' AND student_user_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND academic_term_id IS NULL
         AND class_section_id IS NULL AND teaching_assignment_id IS NULL)
        """,
    )

    # -------------------------------------------------------------------------
    # 8. Notifications: Action Route & Payload JSON
    # -------------------------------------------------------------------------
    op.add_column("notifications", sa.Column("payload_json", sa.Text(), nullable=True))
    op.add_column("notifications", sa.Column("action_route", sa.String(length=255), nullable=True))

    # -------------------------------------------------------------------------
    # 9. Single-Institution Automatic Membership Trigger
    # -------------------------------------------------------------------------
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION trg_auto_create_institution_membership()
            RETURNS TRIGGER AS $$
            DECLARE
                inst_id uuid;
            BEGIN
                SELECT institution_id INTO inst_id FROM deployment_config WHERE singleton_id = 1;
                IF inst_id IS NOT NULL THEN
                    INSERT INTO institution_memberships (id, institution_id, user_id, status, joined_at, created_at, updated_at)
                    VALUES (gen_random_uuid(), inst_id, NEW.id, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT (institution_id, user_id) DO NOTHING;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trg_user_auto_membership ON users;
            CREATE TRIGGER trg_user_auto_membership
            AFTER INSERT ON users
            FOR EACH ROW
            EXECUTE FUNCTION trg_auto_create_institution_membership();
            """
        )
    )


def downgrade() -> None:
    # 9. Membership Trigger
    op.execute(sa.text("DROP TRIGGER IF EXISTS trg_user_auto_membership ON users;"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS trg_auto_create_institution_membership();"))

    # 8. Notifications
    op.drop_column("notifications", "action_route")
    op.drop_column("notifications", "payload_json")

    # 7. Scopes
    op.execute(sa.text("ALTER TABLE delegation_scopes DROP CONSTRAINT IF EXISTS chk_delegation_scope_resource_consistency;"))
    op.drop_constraint("fk_delegation_scope_program", "delegation_scopes", type_="foreignkey")
    op.drop_column("delegation_scopes", "program_id")

    op.execute(sa.text("ALTER TABLE role_assignment_scopes DROP CONSTRAINT IF EXISTS chk_role_scope_resource_consistency;"))
    op.drop_constraint("fk_role_scope_program", "role_assignment_scopes", type_="foreignkey")
    op.drop_column("role_assignment_scopes", "program_id")

    # 6. Delegations
    op.drop_constraint("chk_delegation_type", "delegations", type_="check")
    op.drop_column("delegations", "delegation_type")

    # 5c. report_export_audits
    op.drop_constraint("fk_report_export_delegation", "report_export_audits", type_="foreignkey")
    op.drop_constraint("fk_report_export_authorizing_assignment", "report_export_audits", type_="foreignkey")
    op.drop_constraint("fk_report_export_actor_membership", "report_export_audits", type_="foreignkey")
    op.drop_column("report_export_audits", "scope_resource_id")
    op.drop_column("report_export_audits", "scope_type")
    op.drop_column("report_export_audits", "permission_code")
    op.drop_column("report_export_audits", "delegation_id")
    op.drop_column("report_export_audits", "authorizing_role_assignment_id")
    op.drop_column("report_export_audits", "actor_membership_id")

    # 5b. attendance_amendment_audits
    op.drop_constraint("fk_amendment_delegation", "attendance_amendment_audits", type_="foreignkey")
    op.drop_constraint("fk_amendment_authorizing_assignment", "attendance_amendment_audits", type_="foreignkey")
    op.drop_constraint("fk_amendment_actor_membership", "attendance_amendment_audits", type_="foreignkey")
    op.drop_column("attendance_amendment_audits", "scope_resource_id")
    op.drop_column("attendance_amendment_audits", "scope_type")
    op.drop_column("attendance_amendment_audits", "permission_code")
    op.drop_column("attendance_amendment_audits", "delegation_id")
    op.drop_column("attendance_amendment_audits", "authorizing_role_assignment_id")
    op.drop_column("attendance_amendment_audits", "actor_membership_id")

    # 5a. attendance_sessions
    op.drop_constraint("fk_attendance_session_finalizing_actor", "attendance_sessions", type_="foreignkey")
    op.drop_constraint("fk_attendance_session_authorizing_assignment", "attendance_sessions", type_="foreignkey")
    op.drop_constraint("fk_attendance_session_delegation", "attendance_sessions", type_="foreignkey")
    op.drop_column("attendance_sessions", "matched_scope_id")
    op.drop_column("attendance_sessions", "matched_scope_type")
    op.drop_column("attendance_sessions", "permission_code")
    op.drop_column("attendance_sessions", "finalizing_actor_membership_id")
    op.drop_column("attendance_sessions", "authorizing_role_assignment_id")
    op.drop_column("attendance_sessions", "delegation_id")

    # 4i. report_export_audits
    op.drop_constraint("fk_report_export_deployment_institution", "report_export_audits", type_="foreignkey")
    op.drop_column("report_export_audits", "institution_id")

    # 4h. substitute_delegations
    op.drop_constraint("fk_legacy_substitute_deployment_institution", "substitute_delegations", type_="foreignkey")
    op.drop_column("substitute_delegations", "institution_id")

    # 4g. student_attendance_requests
    op.drop_constraint("fk_student_request_assignment_institution", "student_attendance_requests", type_="foreignkey")
    op.drop_constraint("fk_student_request_session", "student_attendance_requests", type_="foreignkey")
    op.drop_constraint("fk_student_request_deployment_institution", "student_attendance_requests", type_="foreignkey")
    op.drop_column("student_attendance_requests", "attendance_session_id")
    op.drop_column("student_attendance_requests", "institution_id")

    # 4f. attendance_amendment_audits
    op.drop_constraint("fk_amendment_session_institution", "attendance_amendment_audits", type_="foreignkey")
    op.drop_constraint("fk_amendment_deployment_institution", "attendance_amendment_audits", type_="foreignkey")
    op.drop_column("attendance_amendment_audits", "institution_id")

    # 4e. attendance_records
    op.drop_constraint("fk_attendance_record_student_membership", "attendance_records", type_="foreignkey")
    op.drop_constraint("fk_attendance_record_session_institution", "attendance_records", type_="foreignkey")
    op.drop_constraint("fk_attendance_record_deployment_institution", "attendance_records", type_="foreignkey")
    op.drop_column("attendance_records", "institution_id")

    # 4d. attendance_sessions
    op.drop_constraint("fk_attendance_session_assignment_institution", "attendance_sessions", type_="foreignkey")
    op.drop_constraint("fk_attendance_session_deployment_institution", "attendance_sessions", type_="foreignkey")
    op.drop_constraint("uq_attendance_sessions_inst_id", "attendance_sessions", type_="unique")
    op.drop_column("attendance_sessions", "institution_id")

    # 4c. student_face_profiles
    op.drop_constraint("fk_face_profile_student_membership", "student_face_profiles", type_="foreignkey")
    op.drop_constraint("fk_face_profile_deployment_institution", "student_face_profiles", type_="foreignkey")
    op.drop_column("student_face_profiles", "institution_id")

    # 4b. student_enrollments
    op.drop_constraint("fk_enrollment_student_membership", "student_enrollments", type_="foreignkey")
    op.drop_constraint("fk_enrollment_section_term", "student_enrollments", type_="foreignkey")
    op.drop_constraint("fk_enrollment_deployment_institution", "student_enrollments", type_="foreignkey")
    op.drop_column("student_enrollments", "institution_id")

    # 4a. teaching_assignments
    op.drop_constraint("fk_teaching_assignment_faculty_membership", "teaching_assignments", type_="foreignkey")
    op.drop_constraint("fk_teaching_assignment_section_term", "teaching_assignments", type_="foreignkey")
    op.drop_constraint("fk_teaching_assignment_deployment_institution", "teaching_assignments", type_="foreignkey")
    op.drop_constraint("uq_teaching_assignments_inst_id", "teaching_assignments", type_="unique")
    op.drop_column("teaching_assignments", "institution_id")

    # 3. class_sections
    op.drop_constraint("uq_class_sections_inst_id_term", "class_sections", type_="unique")
    op.drop_constraint("fk_class_sections_program_department", "class_sections", type_="foreignkey")
    op.drop_column("class_sections", "program_id")

    # 2. programs
    op.drop_index("ix_programs_department", table_name="programs")
    op.drop_table("programs")

    # 1. deployment_config
    op.drop_table("deployment_config")
