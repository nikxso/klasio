"""student_attendance_requests

Revision ID: 010_student_attendance_requests
Revises: 009_report_export_audit
Create Date: 2026-10-31 12:00:00.000000+00:00

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "010_student_attendance_requests"
down_revision: Union[str, None] = "009_report_export_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "student_attendance_requests",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True),
        sa.Column(
            "student_user_id",
            sa.Uuid(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "teaching_assignment_id",
            sa.Uuid(as_uuid=True),
            sa.ForeignKey("teaching_assignments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("session_date", sa.Date(), nullable=False),
        sa.Column("student_note", sa.Text(), nullable=False),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default="PENDING",
        ),
        sa.Column(
            "reviewer_user_id",
            sa.Uuid(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_student_attendance_requests_student_id",
        "student_attendance_requests",
        ["student_user_id"],
    )
    op.create_index(
        "ix_student_attendance_requests_assignment_id",
        "student_attendance_requests",
        ["teaching_assignment_id"],
    )
    op.create_index(
        "ix_student_attendance_requests_status",
        "student_attendance_requests",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index("ix_student_attendance_requests_status", table_name="student_attendance_requests")
    op.drop_index(
        "ix_student_attendance_requests_assignment_id",
        table_name="student_attendance_requests",
    )
    op.drop_index(
        "ix_student_attendance_requests_student_id",
        table_name="student_attendance_requests",
    )
    op.drop_table("student_attendance_requests")
