from datetime import date, datetime
from typing import Optional
import uuid
from sqlalchemy import Date, DateTime, ForeignKey, SmallInteger, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base, TimestampMixin
from src.models.attendance import AttendanceAmendmentAudit, AmendmentRole


class ReportExportAudit(Base, TimestampMixin):
    __tablename__ = "report_export_audits"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    user_role: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
    )
    export_format: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="CSV",
    )
    report_type: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
    )
    teaching_assignment_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("teaching_assignments.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    academic_term_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
    )
    start_date: Mapped[Optional[date]] = mapped_column(
        Date,
        nullable=True,
    )
    end_date: Mapped[Optional[date]] = mapped_column(
        Date,
        nullable=True,
    )
    row_count: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=0,
    )
    exported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    user = relationship("User")
    teaching_assignment = relationship("TeachingAssignment")

    def __repr__(self) -> str:
        return f"<ReportExportAudit {self.id} User={self.user_id} Type={self.report_type} Rows={self.row_count}>"


__all__ = ["AttendanceAmendmentAudit", "AmendmentRole", "ReportExportAudit"]
