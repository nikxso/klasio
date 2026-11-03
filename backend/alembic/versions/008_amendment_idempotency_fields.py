"""amendment_idempotency_fields

Revision ID: 008_amendment_idempotency_fields
Revises: 007_amendment_audit_fields
Create Date: 2026-10-14 15:00:00.000000+00:00

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "008_amendment_idempotency_fields"
down_revision: Union[str, None] = "007_amendment_audit_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add client_amendment_id column to attendance_amendment_audits
    op.add_column(
        "attendance_amendment_audits",
        sa.Column(
            "client_amendment_id",
            sa.Uuid(as_uuid=True),
            nullable=True,
        ),
    )
    # 2. Add unique index for client_amendment_id
    op.create_index(
        "ix_attendance_amendment_audits_client_amendment_id",
        "attendance_amendment_audits",
        ["client_amendment_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_attendance_amendment_audits_client_amendment_id",
        table_name="attendance_amendment_audits",
    )
    op.drop_column("attendance_amendment_audits", "client_amendment_id")
