"""preserve_attendance_and_audit_history

Revision ID: 014_preserve_attendance_and_audit_history
Revises: 013_preserve_historical_cascades
Create Date: 2026-11-02 01:00:00.000000+00:00

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "014_attendance_audit_preserv"
down_revision: Union[str, None] = "013_preserve_historical_cascades"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. attendance_records -> attendance_sessions: change CASCADE to RESTRICT
    # Prevents deleting AttendanceSession from wiping historical AttendanceRecord entries!
    op.drop_constraint("attendance_records_attendance_session_id_fkey", "attendance_records", type_="foreignkey")
    op.create_foreign_key(
        "attendance_records_attendance_session_id_fkey",
        "attendance_records",
        "attendance_sessions",
        ["attendance_session_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 2. attendance_amendment_audits -> attendance_sessions: change CASCADE to RESTRICT
    # Prevents deleting AttendanceSession from wiping legal amendment audit logs!
    op.drop_constraint("attendance_amendment_audits_attendance_session_id_fkey", "attendance_amendment_audits", type_="foreignkey")
    op.create_foreign_key(
        "attendance_amendment_audits_attendance_session_id_fkey",
        "attendance_amendment_audits",
        "attendance_sessions",
        ["attendance_session_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 3. student_attendance_requests -> teaching_assignments: change CASCADE to RESTRICT
    # Historical student discrepancy requests must remain intact
    op.drop_constraint("student_attendance_requests_teaching_assignment_id_fkey", "student_attendance_requests", type_="foreignkey")
    op.create_foreign_key(
        "student_attendance_requests_teaching_assignment_id_fkey",
        "student_attendance_requests",
        "teaching_assignments",
        ["teaching_assignment_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 4. class_sections -> institutions: change CASCADE to RESTRICT
    # Deleting an Institution must not wipe ClassSections with attendance history!
    op.drop_constraint("fk_class_sections_institution_id", "class_sections", type_="foreignkey")
    op.create_foreign_key(
        "fk_class_sections_institution_id",
        "class_sections",
        "institutions",
        ["institution_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 5. academic_terms -> institutions: change CASCADE to RESTRICT
    # Deleting an Institution must not wipe AcademicTerms with attendance history!
    op.drop_constraint("fk_academic_terms_institution_id", "academic_terms", type_="foreignkey")
    op.create_foreign_key(
        "fk_academic_terms_institution_id",
        "academic_terms",
        "institutions",
        ["institution_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    # 5. academic_terms -> institutions: revert to CASCADE
    op.drop_constraint("fk_academic_terms_institution_id", "academic_terms", type_="foreignkey")
    op.create_foreign_key(
        "fk_academic_terms_institution_id",
        "academic_terms",
        "institutions",
        ["institution_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 4. class_sections -> institutions: revert to CASCADE
    op.drop_constraint("fk_class_sections_institution_id", "class_sections", type_="foreignkey")
    op.create_foreign_key(
        "fk_class_sections_institution_id",
        "class_sections",
        "institutions",
        ["institution_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 3. student_attendance_requests -> teaching_assignments: revert to CASCADE
    op.drop_constraint("student_attendance_requests_teaching_assignment_id_fkey", "student_attendance_requests", type_="foreignkey")
    op.create_foreign_key(
        "student_attendance_requests_teaching_assignment_id_fkey",
        "student_attendance_requests",
        "teaching_assignments",
        ["teaching_assignment_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 2. attendance_amendment_audits -> attendance_sessions: revert to CASCADE
    op.drop_constraint("attendance_amendment_audits_attendance_session_id_fkey", "attendance_amendment_audits", type_="foreignkey")
    op.create_foreign_key(
        "attendance_amendment_audits_attendance_session_id_fkey",
        "attendance_amendment_audits",
        "attendance_sessions",
        ["attendance_session_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 1. attendance_records -> attendance_sessions: revert to CASCADE
    op.drop_constraint("attendance_records_attendance_session_id_fkey", "attendance_records", type_="foreignkey")
    op.create_foreign_key(
        "attendance_records_attendance_session_id_fkey",
        "attendance_records",
        "attendance_sessions",
        ["attendance_session_id"],
        ["id"],
        ondelete="CASCADE",
    )
