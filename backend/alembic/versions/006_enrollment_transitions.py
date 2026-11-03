"""enrollment_transitions

Revision ID: 006_enrollment_transitions
Revises: 005_attendance_core
Create Date: 2026-10-13 15:10:00.000000+00:00

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "006_enrollment_transitions"
down_revision: Union[str, None] = "005_attendance_core"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Enforce at most ONE open-ended (active ongoing) enrollment per student per academic term
    op.create_index(
        "uq_student_term_active_open",
        "student_enrollments",
        ["student_user_id", "academic_term_id"],
        unique=True,
        postgresql_where=sa.text("effective_end_date IS NULL"),
    )

    # 2. Add composite index on (student_user_id, enrollment_status) for historical filtering
    op.create_index(
        "ix_student_enrollments_student_status",
        "student_enrollments",
        ["student_user_id", "enrollment_status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_student_enrollments_student_status", table_name="student_enrollments")
    op.drop_index("uq_student_term_active_open", table_name="student_enrollments")
