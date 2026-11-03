"""preserve_historical_cascades

Revision ID: 013_preserve_historical_cascades
Revises: 012_composite_tenant_keys
Create Date: 2026-11-01 19:00:00.000000+00:00

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "013_preserve_historical_cascades"
down_revision: Union[str, None] = "012_composite_tenant_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. ClassSection parent relationships: change CASCADE to RESTRICT
    # Prevents deleting Campus, Department, or AcademicTerm from wiping ClassSections
    op.drop_constraint("fk_class_sections_inst_campus", "class_sections", type_="foreignkey")
    op.drop_constraint("fk_class_sections_inst_department", "class_sections", type_="foreignkey")
    op.drop_constraint("fk_class_sections_inst_term", "class_sections", type_="foreignkey")

    op.create_foreign_key(
        "fk_class_sections_inst_campus",
        "class_sections",
        "campuses",
        ["institution_id", "campus_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_class_sections_inst_department",
        "class_sections",
        "departments",
        ["institution_id", "department_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_class_sections_inst_term",
        "class_sections",
        "academic_terms",
        ["institution_id", "academic_term_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )

    # 2. Subjects -> Departments: change CASCADE to RESTRICT
    op.drop_constraint("fk_subjects_inst_department", "subjects", type_="foreignkey")
    op.create_foreign_key(
        "fk_subjects_inst_department",
        "subjects",
        "departments",
        ["institution_id", "department_id"],
        ["institution_id", "id"],
        ondelete="RESTRICT",
    )

    # 3. TeachingAssignments parent relationships: change CASCADE to RESTRICT
    # Prevents deleting ClassSection, AcademicTerm, or Subject from deleting TeachingAssignments
    op.drop_constraint("teaching_assignments_class_section_id_fkey", "teaching_assignments", type_="foreignkey")
    op.drop_constraint("teaching_assignments_academic_term_id_fkey", "teaching_assignments", type_="foreignkey")
    op.drop_constraint("teaching_assignments_subject_id_fkey", "teaching_assignments", type_="foreignkey")

    op.create_foreign_key(
        "teaching_assignments_class_section_id_fkey",
        "teaching_assignments",
        "class_sections",
        ["class_section_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "teaching_assignments_academic_term_id_fkey",
        "teaching_assignments",
        "academic_terms",
        ["academic_term_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "teaching_assignments_subject_id_fkey",
        "teaching_assignments",
        "subjects",
        ["subject_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 4. StudentEnrollments parent relationships: change CASCADE to RESTRICT
    # Prevents deleting ClassSection or AcademicTerm from deleting StudentEnrollments
    op.drop_constraint("student_enrollments_class_section_id_fkey", "student_enrollments", type_="foreignkey")
    op.drop_constraint("student_enrollments_academic_term_id_fkey", "student_enrollments", type_="foreignkey")

    op.create_foreign_key(
        "student_enrollments_class_section_id_fkey",
        "student_enrollments",
        "class_sections",
        ["class_section_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "student_enrollments_academic_term_id_fkey",
        "student_enrollments",
        "academic_terms",
        ["academic_term_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 5. AttendanceSessions -> TeachingAssignments: change CASCADE to RESTRICT
    # Prevents deleting TeachingAssignment from deleting AttendanceSessions, Records, and Audits!
    op.drop_constraint("attendance_sessions_teaching_assignment_id_fkey", "attendance_sessions", type_="foreignkey")
    op.create_foreign_key(
        "attendance_sessions_teaching_assignment_id_fkey",
        "attendance_sessions",
        "teaching_assignments",
        ["teaching_assignment_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 6. RoleAssignmentScope & DelegationScope: Composite FK for STUDENT scope type
    # Enforces that student_user_id belongs to the scope's institution via institution_memberships(institution_id, user_id)
    op.create_foreign_key(
        "fk_role_scopes_inst_student_membership",
        "role_assignment_scopes",
        "institution_memberships",
        ["institution_id", "student_user_id"],
        ["institution_id", "user_id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_delg_scopes_inst_student_membership",
        "delegation_scopes",
        "institution_memberships",
        ["institution_id", "student_user_id"],
        ["institution_id", "user_id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    # 6. Revert student scope composite FKs
    op.drop_constraint("fk_delg_scopes_inst_student_membership", "delegation_scopes", type_="foreignkey")
    op.drop_constraint("fk_role_scopes_inst_student_membership", "role_assignment_scopes", type_="foreignkey")

    # 5. Revert AttendanceSessions
    op.drop_constraint("attendance_sessions_teaching_assignment_id_fkey", "attendance_sessions", type_="foreignkey")
    op.create_foreign_key(
        "attendance_sessions_teaching_assignment_id_fkey",
        "attendance_sessions",
        "teaching_assignments",
        ["teaching_assignment_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 4. Revert StudentEnrollments
    op.drop_constraint("student_enrollments_academic_term_id_fkey", "student_enrollments", type_="foreignkey")
    op.drop_constraint("student_enrollments_class_section_id_fkey", "student_enrollments", type_="foreignkey")
    op.create_foreign_key(
        "student_enrollments_academic_term_id_fkey",
        "student_enrollments",
        "academic_terms",
        ["academic_term_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "student_enrollments_class_section_id_fkey",
        "student_enrollments",
        "class_sections",
        ["class_section_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 3. Revert TeachingAssignments
    op.drop_constraint("teaching_assignments_subject_id_fkey", "teaching_assignments", type_="foreignkey")
    op.drop_constraint("teaching_assignments_academic_term_id_fkey", "teaching_assignments", type_="foreignkey")
    op.drop_constraint("teaching_assignments_class_section_id_fkey", "teaching_assignments", type_="foreignkey")
    op.create_foreign_key(
        "teaching_assignments_subject_id_fkey",
        "teaching_assignments",
        "subjects",
        ["subject_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "teaching_assignments_academic_term_id_fkey",
        "teaching_assignments",
        "academic_terms",
        ["academic_term_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "teaching_assignments_class_section_id_fkey",
        "teaching_assignments",
        "class_sections",
        ["class_section_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 2. Revert Subjects
    op.drop_constraint("fk_subjects_inst_department", "subjects", type_="foreignkey")
    op.create_foreign_key(
        "fk_subjects_inst_department",
        "subjects",
        "departments",
        ["institution_id", "department_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )

    # 1. Revert ClassSections
    op.drop_constraint("fk_class_sections_inst_term", "class_sections", type_="foreignkey")
    op.drop_constraint("fk_class_sections_inst_department", "class_sections", type_="foreignkey")
    op.drop_constraint("fk_class_sections_inst_campus", "class_sections", type_="foreignkey")
    op.create_foreign_key(
        "fk_class_sections_inst_term",
        "class_sections",
        "academic_terms",
        ["institution_id", "academic_term_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_class_sections_inst_department",
        "class_sections",
        "departments",
        ["institution_id", "department_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_class_sections_inst_campus",
        "class_sections",
        "campuses",
        ["institution_id", "campus_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
