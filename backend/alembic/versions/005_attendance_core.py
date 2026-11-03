"""attendance_core

Revision ID: 005_attendance_core
Revises: 004_delegation_core
Create Date: 2026-10-13 12:30:00.000000+00:00

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "005_attendance_core"
down_revision: Union[str, None] = "004_delegation_core"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create attendance_sessions table
    op.create_table(
        "attendance_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_session_uuid", sa.Uuid(), nullable=False),
        sa.Column("teaching_assignment_id", sa.Uuid(), nullable=False),
        sa.Column("session_date", sa.Date(), nullable=False),
        sa.Column("period_slot_or_sequence", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column(
            "applicability_status",
            sa.Enum("COUNTED", "CANCELLED", "EXEMPT", name="session_applicability", native_enum=False),
            nullable=False,
            server_default="COUNTED",
        ),
        sa.Column("status_reason", sa.Text(), nullable=True),
        sa.Column("regular_faculty_user_id", sa.Uuid(), nullable=False),
        sa.Column("conducting_faculty_user_id", sa.Uuid(), nullable=False),
        sa.Column("substitute_delegation_id", sa.Uuid(), nullable=True),
        sa.Column(
            "session_status",
            sa.Enum("DRAFT", "FINALIZED", "SYNCED", name="attendance_session_status", native_enum=False),
            nullable=False,
            server_default="FINALIZED",
        ),
        sa.Column("finalized_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=True),
        sa.Column("records_count", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("present_count", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("absent_count", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("excused_count", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["teaching_assignment_id"], ["teaching_assignments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["regular_faculty_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["conducting_faculty_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["substitute_delegation_id"], ["substitute_delegations.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("client_session_uuid", name="uq_attendance_session_client_uuid"),
        sa.UniqueConstraint("teaching_assignment_id", "session_date", "period_slot_or_sequence", name="uq_assignment_session_slot"),
    )
    op.create_index("ix_attendance_sessions_client_uuid", "attendance_sessions", ["client_session_uuid"])
    op.create_index("ix_attendance_sessions_assignment_id", "attendance_sessions", ["teaching_assignment_id"])
    op.create_index("ix_attendance_sessions_date", "attendance_sessions", ["session_date"])
    op.create_index("ix_attendance_sessions_assignment_date", "attendance_sessions", ["teaching_assignment_id", "session_date"])
    op.create_index("ix_attendance_sessions_payload_hash", "attendance_sessions", ["payload_hash"])

    # 2. Create attendance_records table
    op.create_table(
        "attendance_records",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("attendance_session_id", sa.Uuid(), nullable=False),
        sa.Column("student_user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "attendance_status",
            sa.Enum("PRESENT", "ABSENT", "EXCUSED", name="attendance_status", native_enum=False),
            nullable=False,
        ),
        sa.Column(
            "mark_source",
            sa.Enum("AI_VERIFIED", "MANUAL_MARK", "MANUAL_OVERRIDE", name="mark_source", native_enum=False),
            nullable=False,
            server_default="MANUAL_MARK",
        ),
        sa.Column("candidate_confidence", sa.Float(), nullable=True),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["attendance_session_id"], ["attendance_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["student_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("attendance_session_id", "student_user_id", name="uq_session_student_record"),
    )
    op.create_index("ix_attendance_records_session_id", "attendance_records", ["attendance_session_id"])
    op.create_index("ix_attendance_records_student_id", "attendance_records", ["student_user_id"])
    op.create_index("ix_attendance_records_student_session", "attendance_records", ["student_user_id", "attendance_session_id"])

    # 3. Create attendance_amendment_audits table
    op.create_table(
        "attendance_amendment_audits",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("attendance_session_id", sa.Uuid(), nullable=False),
        sa.Column("student_user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "previous_status",
            sa.Enum("PRESENT", "ABSENT", "EXCUSED", name="amendment_prev_status", native_enum=False),
            nullable=False,
        ),
        sa.Column(
            "new_status",
            sa.Enum("PRESENT", "ABSENT", "EXCUSED", name="amendment_new_status", native_enum=False),
            nullable=False,
        ),
        sa.Column("amending_user_id", sa.Uuid(), nullable=False),
        sa.Column("amendment_reason", sa.Text(), nullable=False),
        sa.Column("amended_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["attendance_session_id"], ["attendance_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["student_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["amending_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_attendance_amendment_audits_session_id", "attendance_amendment_audits", ["attendance_session_id"])
    op.create_index("ix_attendance_amendment_audits_student_id", "attendance_amendment_audits", ["student_user_id"])


def downgrade() -> None:
    op.drop_table("attendance_amendment_audits")
    op.drop_table("attendance_records")
    op.drop_table("attendance_sessions")
