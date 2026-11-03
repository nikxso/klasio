"""restrict_user_history_cascades

Revision ID: 015_restrict_user_history_casc
Revises: 014_attendance_audit_preserv
Create Date: 2026-11-02 02:00:00.000000+00:00

Ensures historical attendance sessions, attendance records, amendment audits,
student requests, and report export audits cannot be unexpectedly erased
via DELETE FROM users. User lifecycle must use soft deactivation/suspension.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "015_restrict_user_history_casc"
down_revision: Union[str, None] = "014_attendance_audit_preserv"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. attendance_records.student_user_id -> users.id: CASCADE -> RESTRICT
    op.drop_constraint("attendance_records_student_user_id_fkey", "attendance_records", type_="foreignkey")
    op.create_foreign_key(
        "attendance_records_student_user_id_fkey",
        "attendance_records",
        "users",
        ["student_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 2. attendance_sessions.regular_faculty_user_id -> users.id: CASCADE -> RESTRICT
    op.drop_constraint("attendance_sessions_regular_faculty_user_id_fkey", "attendance_sessions", type_="foreignkey")
    op.create_foreign_key(
        "attendance_sessions_regular_faculty_user_id_fkey",
        "attendance_sessions",
        "users",
        ["regular_faculty_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 3. attendance_sessions.conducting_faculty_user_id -> users.id: CASCADE -> RESTRICT
    op.drop_constraint("attendance_sessions_conducting_faculty_user_id_fkey", "attendance_sessions", type_="foreignkey")
    op.create_foreign_key(
        "attendance_sessions_conducting_faculty_user_id_fkey",
        "attendance_sessions",
        "users",
        ["conducting_faculty_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 4. attendance_amendment_audits.student_user_id -> users.id: CASCADE -> RESTRICT
    op.drop_constraint("attendance_amendment_audits_student_user_id_fkey", "attendance_amendment_audits", type_="foreignkey")
    op.create_foreign_key(
        "attendance_amendment_audits_student_user_id_fkey",
        "attendance_amendment_audits",
        "users",
        ["student_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 5. student_attendance_requests.student_user_id -> users.id: CASCADE -> RESTRICT
    op.drop_constraint("student_attendance_requests_student_user_id_fkey", "student_attendance_requests", type_="foreignkey")
    op.create_foreign_key(
        "student_attendance_requests_student_user_id_fkey",
        "student_attendance_requests",
        "users",
        ["student_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # 6. report_export_audits.user_id -> users.id: CASCADE -> RESTRICT
    op.drop_constraint("report_export_audits_user_id_fkey", "report_export_audits", type_="foreignkey")
    op.create_foreign_key(
        "report_export_audits_user_id_fkey",
        "report_export_audits",
        "users",
        ["user_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    # 6. report_export_audits.user_id -> users.id: RESTRICT -> CASCADE
    op.drop_constraint("report_export_audits_user_id_fkey", "report_export_audits", type_="foreignkey")
    op.create_foreign_key(
        "report_export_audits_user_id_fkey",
        "report_export_audits",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 5. student_attendance_requests.student_user_id -> users.id: RESTRICT -> CASCADE
    op.drop_constraint("student_attendance_requests_student_user_id_fkey", "student_attendance_requests", type_="foreignkey")
    op.create_foreign_key(
        "student_attendance_requests_student_user_id_fkey",
        "student_attendance_requests",
        "users",
        ["student_user_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 4. attendance_amendment_audits.student_user_id -> users.id: RESTRICT -> CASCADE
    op.drop_constraint("attendance_amendment_audits_student_user_id_fkey", "attendance_amendment_audits", type_="foreignkey")
    op.create_foreign_key(
        "attendance_amendment_audits_student_user_id_fkey",
        "attendance_amendment_audits",
        "users",
        ["student_user_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 3. attendance_sessions.conducting_faculty_user_id -> users.id: RESTRICT -> CASCADE
    op.drop_constraint("attendance_sessions_conducting_faculty_user_id_fkey", "attendance_sessions", type_="foreignkey")
    op.create_foreign_key(
        "attendance_sessions_conducting_faculty_user_id_fkey",
        "attendance_sessions",
        "users",
        ["conducting_faculty_user_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 2. attendance_sessions.regular_faculty_user_id -> users.id: RESTRICT -> CASCADE
    op.drop_constraint("attendance_sessions_regular_faculty_user_id_fkey", "attendance_sessions", type_="foreignkey")
    op.create_foreign_key(
        "attendance_sessions_regular_faculty_user_id_fkey",
        "attendance_sessions",
        "users",
        ["regular_faculty_user_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 1. attendance_records.student_user_id -> users.id: RESTRICT -> CASCADE
    op.drop_constraint("attendance_records_student_user_id_fkey", "attendance_records", type_="foreignkey")
    op.create_foreign_key(
        "attendance_records_student_user_id_fkey",
        "attendance_records",
        "users",
        ["student_user_id"],
        ["id"],
        ondelete="CASCADE",
    )
