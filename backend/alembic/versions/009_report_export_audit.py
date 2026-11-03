"""report_export_audit

Revision ID: 009_report_export_audit
Revises: 008_amendment_idempotency_fields
Create Date: 2026-10-29 03:00:00.000000+00:00

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "009_report_export_audit"
down_revision: Union[str, None] = "008_amendment_idempotency_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_export_audits",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True),
        sa.Column("user_id", sa.Uuid(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_role", sa.String(length=32), nullable=False),
        sa.Column("export_format", sa.String(length=16), nullable=False, server_default="CSV"),
        sa.Column("report_type", sa.String(length=64), nullable=False),
        sa.Column("teaching_assignment_id", sa.Uuid(as_uuid=True), sa.ForeignKey("teaching_assignments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("academic_term_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("row_count", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("exported_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_report_export_audits_user_id", "report_export_audits", ["user_id"])
    op.create_index("ix_report_export_audits_teaching_assignment_id", "report_export_audits", ["teaching_assignment_id"])


def downgrade() -> None:
    op.drop_index("ix_report_export_audits_teaching_assignment_id", table_name="report_export_audits")
    op.drop_index("ix_report_export_audits_user_id", table_name="report_export_audits")
    op.drop_table("report_export_audits")
