"""academic_timetable_enrollment

Revision ID: 018_academic_timetable_enrollment
Revises: 017_target_schema_patch
Create Date: 2026-11-27 12:00:00.000000+00:00

Implements configurable academic periods, weekly timetable scheduling with
conflict prevention, enhanced teaching assignment groups/statuses, and
timetable-to-attendance session foreign key linkage.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "018_academic_timetable_enrollment"
down_revision: Union[str, None] = "017_target_schema_patch"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEFAULT_INST_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    # -------------------------------------------------------------------------
    # 1. Academic Periods Table
    # -------------------------------------------------------------------------
    op.create_table(
        "academic_periods",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("institution_id", sa.Uuid(), nullable=False),
        sa.Column("period_number", sa.SmallInteger(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("start_time", sa.Time(), nullable=False),
        sa.Column("end_time", sa.Time(), nullable=False),
        sa.Column("is_break", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint("end_time > start_time", name="chk_period_time_range"),
        sa.CheckConstraint("period_number >= 1 AND period_number <= 20", name="chk_period_number_range"),
        sa.ForeignKeyConstraint(
            ["institution_id"],
            ["deployment_config.institution_id"],
            name="fk_periods_deployment_institution",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("institution_id", "period_number", name="uq_period_institution_number"),
        sa.UniqueConstraint("institution_id", "id", name="uq_academic_periods_inst_id"),
    )

    # Seed default academic periods for single-institution instance
    op.execute(
        sa.text(
            f"""
            INSERT INTO academic_periods (id, institution_id, period_number, name, start_time, end_time, is_break, is_active)
            VALUES
                (gen_random_uuid(), '{DEFAULT_INST_ID}', 1, 'Period 1', '09:00:00', '10:00:00', false, true),
                (gen_random_uuid(), '{DEFAULT_INST_ID}', 2, 'Period 2', '10:00:00', '11:00:00', false, true),
                (gen_random_uuid(), '{DEFAULT_INST_ID}', 3, 'Period 3', '11:00:00', '12:00:00', false, true),
                (gen_random_uuid(), '{DEFAULT_INST_ID}', 4, 'Lunch Break', '12:00:00', '13:00:00', true, true),
                (gen_random_uuid(), '{DEFAULT_INST_ID}', 5, 'Period 4', '13:00:00', '14:00:00', false, true),
                (gen_random_uuid(), '{DEFAULT_INST_ID}', 6, 'Period 5', '14:00:00', '15:00:00', false, true),
                (gen_random_uuid(), '{DEFAULT_INST_ID}', 7, 'Period 6', '15:00:00', '16:00:00', false, true),
                (gen_random_uuid(), '{DEFAULT_INST_ID}', 8, 'Period 7', '16:00:00', '17:00:00', false, true)
            ON CONFLICT (institution_id, period_number) DO NOTHING;
            """
        )
    )

    # -------------------------------------------------------------------------
    # 2. Enhance Teaching Assignments (Groups, Status, Effective Dates)
    # -------------------------------------------------------------------------
    op.add_column(
        "teaching_assignments",
        sa.Column("teaching_group", sa.String(length=64), server_default=sa.text("'DEFAULT'"), nullable=False),
    )
    op.add_column(
        "teaching_assignments",
        sa.Column("assignment_status", sa.String(length=32), server_default=sa.text("'ACTIVE'"), nullable=False),
    )
    op.add_column("teaching_assignments", sa.Column("start_date", sa.Date(), nullable=True))
    op.add_column("teaching_assignments", sa.Column("end_date", sa.Date(), nullable=True))

    # Update unique constraint on teaching assignments to allow multiple teaching groups (e.g. Lab A, Lab B, Lecture)
    op.drop_constraint("uq_section_subject_term", "teaching_assignments", type_="unique")
    op.create_unique_constraint(
        "uq_section_subject_term_group",
        "teaching_assignments",
        ["class_section_id", "subject_id", "academic_term_id", "teaching_group"],
    )

    # -------------------------------------------------------------------------
    # 3. Timetable Entries Table
    # -------------------------------------------------------------------------
    op.create_table(
        "timetable_entries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("institution_id", sa.Uuid(), nullable=False),
        sa.Column("academic_term_id", sa.Uuid(), nullable=False),
        sa.Column("class_section_id", sa.Uuid(), nullable=False),
        sa.Column("teaching_assignment_id", sa.Uuid(), nullable=False),
        sa.Column("academic_period_id", sa.Uuid(), nullable=False),
        sa.Column("day_of_week", sa.SmallInteger(), nullable=False),
        sa.Column("room_number", sa.String(length=64), server_default=sa.text("'TBD'"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint("day_of_week >= 1 AND day_of_week <= 7", name="chk_timetable_day_range"),
        sa.ForeignKeyConstraint(
            ["institution_id"],
            ["deployment_config.institution_id"],
            name="fk_timetable_deployment_institution",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["institution_id", "academic_term_id"],
            ["academic_terms.institution_id", "academic_terms.id"],
            name="fk_timetable_academic_term",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["institution_id", "class_section_id"],
            ["class_sections.institution_id", "class_sections.id"],
            name="fk_timetable_class_section",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["institution_id", "academic_period_id"],
            ["academic_periods.institution_id", "academic_periods.id"],
            name="fk_timetable_academic_period",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["teaching_assignment_id"],
            ["teaching_assignments.id"],
            name="fk_timetable_teaching_assignment",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("class_section_id", "day_of_week", "academic_period_id", name="uq_timetable_section_slot"),
        sa.UniqueConstraint("institution_id", "room_number", "day_of_week", "academic_period_id", name="uq_timetable_room_slot"),
    )
    op.create_index("ix_timetable_assignment_day", "timetable_entries", ["teaching_assignment_id", "day_of_week"])

    # -------------------------------------------------------------------------
    # 4. Link Attendance Sessions to Timetable Entries
    # -------------------------------------------------------------------------
    op.add_column("attendance_sessions", sa.Column("timetable_entry_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_attendance_sessions_timetable_entry",
        "attendance_sessions",
        "timetable_entries",
        ["timetable_entry_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_attendance_sessions_timetable", "attendance_sessions", ["timetable_entry_id"])


def downgrade() -> None:
    op.drop_index("ix_attendance_sessions_timetable", table_name="attendance_sessions")
    op.drop_constraint("fk_attendance_sessions_timetable_entry", "attendance_sessions", type_="foreignkey")
    op.drop_column("attendance_sessions", "timetable_entry_id")

    op.drop_table("timetable_entries")

    op.drop_constraint("uq_section_subject_term_group", "teaching_assignments", type_="unique")
    op.create_unique_constraint("uq_section_subject_term", "teaching_assignments", ["class_section_id", "subject_id", "academic_term_id"])
    op.drop_column("teaching_assignments", "end_date")
    op.drop_column("teaching_assignments", "start_date")
    op.drop_column("teaching_assignments", "assignment_status")
    op.drop_column("teaching_assignments", "teaching_group")

    op.drop_table("academic_periods")
