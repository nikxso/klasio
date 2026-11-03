"""amendment_audit_fields

Revision ID: 007_amendment_audit_fields
Revises: 006_enrollment_transitions
Create Date: 2026-10-13 16:30:00.000000+00:00

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "007_amendment_audit_fields"
down_revision: Union[str, None] = "006_enrollment_transitions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add amendment_role column to attendance_amendment_audits
    op.add_column(
        "attendance_amendment_audits",
        sa.Column(
            "amendment_role",
            sa.Enum("REGULAR_FACULTY", "ADMIN", name="amendment_role", native_enum=False),
            nullable=False,
            server_default="REGULAR_FACULTY",
        ),
    )
    # Remove server_default so future inserts must supply it explicitly
    op.alter_column("attendance_amendment_audits", "amendment_role", server_default=None)

    # 2. Add check constraint ensuring status actually changes
    op.create_check_constraint(
        "ck_amendment_status_changed",
        "attendance_amendment_audits",
        "new_status != previous_status",
    )

    # 3. Add check constraint ensuring amendment reason has minimum length of 10
    op.create_check_constraint(
        "ck_amendment_reason_length",
        "attendance_amendment_audits",
        "length(amendment_reason) >= 10",
    )


def downgrade() -> None:
    op.drop_constraint("ck_amendment_reason_length", "attendance_amendment_audits", type_="check")
    op.drop_constraint("ck_amendment_status_changed", "attendance_amendment_audits", type_="check")
    op.drop_column("attendance_amendment_audits", "amendment_role")
