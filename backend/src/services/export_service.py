import csv
from datetime import date, datetime, timezone
import io
import re
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple
import uuid
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.exceptions import EntityNotFoundError, UnauthorizedRoleError
from src.models.academic import AcademicTerm, ClassSection, Subject
from src.models.assignment import TeachingAssignment
from src.models.attendance import (
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    SessionApplicability,
)
from src.models.audit import ReportExportAudit
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import User, UserRole
from src.services.analytics_service import AnalyticsService
from src.services.scoping_service import ScopingService


UNSAFE_CSV_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def sanitize_csv_cell(value: Any) -> str:
    """
    Sanitize untrusted cell content to prevent CSV formula injection (DDE attacks).
    Prepends a single quote if the string starts with '=', '+', '-', '@', '\\t', or '\\r'.
    """
    if value is None:
        return ""
    val_str = str(value)
    if val_str.startswith(UNSAFE_CSV_PREFIXES):
        return f"'{val_str}"
    return val_str


def generate_safe_filename(prefix: str, identifier: str, date_str: Optional[str] = None) -> str:
    """
    Generate a sanitized, safe filename free of path traversal or shell characters.
    """
    clean_prefix = re.sub(r"[^a-zA-Z0-9_\-]", "", prefix)
    clean_id = re.sub(r"[^a-zA-Z0-9_\-]", "", identifier)
    suffix = re.sub(r"[^a-zA-Z0-9_\-]", "", date_str) if date_str else datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"{clean_prefix}_{clean_id}_{suffix}.csv"


class ExportService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def log_export_audit(
        self,
        user: User,
        report_type: str,
        teaching_assignment_id: Optional[uuid.UUID],
        academic_term_id: Optional[uuid.UUID],
        start_date: Optional[date],
        end_date: Optional[date],
        row_count: int,
    ) -> ReportExportAudit:
        """Record an export operation in the audit trail."""
        audit = ReportExportAudit(
            user_id=user.id,
            user_role=user.role.value,
            export_format="CSV",
            report_type=report_type,
            teaching_assignment_id=teaching_assignment_id,
            academic_term_id=academic_term_id,
            start_date=start_date,
            end_date=end_date,
            row_count=row_count,
            exported_at=datetime.now(timezone.utc),
        )
        self.db.add(audit)
        await self.db.commit()
        return audit

    async def generate_assignment_roster_csv(
        self,
        current_user: User,
        teaching_assignment_id: uuid.UUID,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
        shortage_only: bool = False,
        threshold: float = 75.0,
    ) -> Tuple[str, AsyncGenerator[str, None]]:
        """
        Export student roster attendance summary for a teaching assignment.
        Returns (filename, generator_yielding_csv_chunks).
        """
        # 1. Scoping and analytics calculation
        analytics_service = AnalyticsService(self.db)
        data = await analytics_service.get_assignment_analytics(
            current_user=current_user,
            teaching_assignment_id=teaching_assignment_id,
            threshold=threshold,
            start_date=start_date,
            end_date=end_date,
        )

        rows_source = data.roster_summaries
        if shortage_only:
            rows_source = [r for r in rows_source if r.is_shortage]

        # Log audit entry
        await self.log_export_audit(
            user=current_user,
            report_type="ASSIGNMENT_ROSTER",
            teaching_assignment_id=teaching_assignment_id,
            academic_term_id=data.academic_term_id,
            start_date=start_date,
            end_date=end_date,
            row_count=len(rows_source),
        )

        safe_filename = generate_safe_filename(
            prefix="attendance_roster",
            identifier=f"{data.subject_code}_{data.section_code}",
        )

        headers = [
            "Institutional ID",
            "Student Name",
            "Subject Code",
            "Subject Name",
            "Section Code",
            "Total Eligible Sessions",
            "Attended Sessions",
            "Attendance Percentage",
            "Consecutive Absences",
            "Shortage Status",
            "Recovery Classes Needed",
            "Margin Can Miss",
            "Threshold",
        ]

        async def csv_streamer() -> AsyncGenerator[str, None]:
            # UTF-8 Byte Order Mark for Excel compatibility
            yield "\ufeff"

            # Header row
            buf = io.StringIO()
            writer = csv.writer(buf, lineterminator="\r\n")
            writer.writerow(headers)
            yield buf.getvalue()

            for item in rows_source:
                buf = io.StringIO()
                writer = csv.writer(buf, lineterminator="\r\n")

                pct_str = f"{item.attendance_percentage:.1f}%" if item.attendance_percentage is not None else "N/A"
                recover_str = (
                    "Unreachable"
                    if not item.is_recoverable
                    else str(item.classes_to_recover)
                    if item.classes_to_recover is not None
                    else "0"
                )

                row = [
                    sanitize_csv_cell(item.institutional_id),
                    sanitize_csv_cell(item.student_name),
                    sanitize_csv_cell(data.subject_code),
                    sanitize_csv_cell(data.subject_name),
                    sanitize_csv_cell(data.section_code),
                    sanitize_csv_cell(item.total_eligible_sessions),
                    sanitize_csv_cell(item.attended_sessions),
                    sanitize_csv_cell(pct_str),
                    sanitize_csv_cell(item.consecutive_absences),
                    sanitize_csv_cell("YES" if item.is_shortage else "NO"),
                    sanitize_csv_cell(recover_str),
                    sanitize_csv_cell(item.classes_can_miss),
                    sanitize_csv_cell(f"{data.threshold:.1f}%"),
                ]
                writer.writerow(row)
                yield buf.getvalue()

        return safe_filename, csv_streamer()

    async def generate_assignment_sessions_csv(
        self,
        current_user: User,
        teaching_assignment_id: uuid.UUID,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
    ) -> Tuple[str, AsyncGenerator[str, None]]:
        """
        Export chronological attendance session records for a teaching assignment.
        Returns (filename, generator_yielding_csv_chunks).
        """
        # Scoping check
        if current_user.role == UserRole.STUDENT:
            raise UnauthorizedRoleError("Students cannot export session records")
        if current_user.role == UserRole.FACULTY:
            scoping = ScopingService(self.db)
            await scoping.verify_faculty_scope(
                faculty_user_id=current_user.id,
                teaching_assignment_id=teaching_assignment_id,
                session_date=date.today(),
            )

        # Fetch teaching assignment
        ta_stmt = (
            select(TeachingAssignment)
            .options(
                selectinload(TeachingAssignment.class_section),
                selectinload(TeachingAssignment.subject),
            )
            .where(TeachingAssignment.id == teaching_assignment_id)
        )
        ta_res = await self.db.execute(ta_stmt)
        ta = ta_res.scalar_one_or_none()
        if not ta:
            raise EntityNotFoundError(f"Teaching assignment {teaching_assignment_id} not found")

        # Fetch sessions
        sess_stmt = (
            select(AttendanceSession)
            .where(
                and_(
                    AttendanceSession.teaching_assignment_id == teaching_assignment_id,
                    AttendanceSession.session_status == AttendanceSessionStatus.FINALIZED,
                )
            )
            .order_by(AttendanceSession.session_date.asc(), AttendanceSession.period_slot_or_sequence.asc())
        )
        if start_date:
            sess_stmt = sess_stmt.where(AttendanceSession.session_date >= start_date)
        if end_date:
            sess_stmt = sess_stmt.where(AttendanceSession.session_date <= end_date)

        sess_res = await self.db.execute(sess_stmt)
        sessions = sess_res.scalars().all()
        session_ids = [s.id for s in sessions]

        # Fetch enrollments
        enr_stmt = (
            select(StudentEnrollment)
            .options(selectinload(StudentEnrollment.student_user))
            .where(
                and_(
                    StudentEnrollment.class_section_id == ta.class_section_id,
                    StudentEnrollment.enrollment_status.in_([EnrollmentStatus.ACTIVE, EnrollmentStatus.TRANSFERRED]),
                )
            )
            .order_by(StudentEnrollment.created_at.asc())
        )
        enr_res = await self.db.execute(enr_stmt)
        enrollments = enr_res.scalars().all()

        # Fetch records
        rec_map: Dict[Tuple[uuid.UUID, uuid.UUID], AttendanceRecord] = {}
        if session_ids:
            rec_stmt = select(AttendanceRecord).where(
                AttendanceRecord.attendance_session_id.in_(session_ids)
            )
            rec_res = await self.db.execute(rec_stmt)
            for r in rec_res.scalars().all():
                rec_map[(r.attendance_session_id, r.student_user_id)] = r

        # Calculate row count
        total_rows = 0
        for s in sessions:
            for enr in enrollments:
                if s.session_date >= enr.effective_start_date and (
                    enr.effective_end_date is None or s.session_date <= enr.effective_end_date
                ):
                    total_rows += 1

        await self.log_export_audit(
            user=current_user,
            report_type="ASSIGNMENT_SESSIONS",
            teaching_assignment_id=teaching_assignment_id,
            academic_term_id=ta.academic_term_id,
            start_date=start_date,
            end_date=end_date,
            row_count=total_rows,
        )

        safe_filename = generate_safe_filename(
            prefix="attendance_sessions",
            identifier=f"{ta.subject.code}_{ta.class_section.section_code}",
        )

        headers = [
            "Session Date",
            "Period Slot",
            "Session Status",
            "Applicability",
            "Status Reason",
            "Institutional ID",
            "Student Name",
            "Attendance Status",
            "Mark Source",
            "Recorded At",
        ]

        async def csv_streamer() -> AsyncGenerator[str, None]:
            yield "\ufeff"
            buf = io.StringIO()
            writer = csv.writer(buf, lineterminator="\r\n")
            writer.writerow(headers)
            yield buf.getvalue()

            for s in sessions:
                for enr in enrollments:
                    if s.session_date < enr.effective_start_date or (
                        enr.effective_end_date is not None and s.session_date > enr.effective_end_date
                    ):
                        continue

                    rec = rec_map.get((s.id, enr.student_user_id))
                    status = rec.attendance_status.value if rec else AttendanceStatus.ABSENT.value
                    mark_source = rec.mark_source.value if rec and rec.mark_source else "UNRECORDED"
                    rec_at = rec.recorded_at.isoformat() if rec and rec.recorded_at else ""

                    buf = io.StringIO()
                    writer = csv.writer(buf, lineterminator="\r\n")
                    row = [
                        sanitize_csv_cell(s.session_date.isoformat()),
                        sanitize_csv_cell(s.period_slot_or_sequence),
                        sanitize_csv_cell(s.session_status.value),
                        sanitize_csv_cell(s.applicability_status.value),
                        sanitize_csv_cell(s.status_reason or ""),
                        sanitize_csv_cell(enr.student_user.institutional_id),
                        sanitize_csv_cell(enr.student_user.full_name),
                        sanitize_csv_cell(status),
                        sanitize_csv_cell(mark_source),
                        sanitize_csv_cell(rec_at),
                    ]
                    writer.writerow(row)
                    yield buf.getvalue()

        return safe_filename, csv_streamer()

    async def generate_overview_csv(
        self,
        current_user: User,
        academic_term_id: Optional[uuid.UUID] = None,
        threshold: float = 75.0,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
    ) -> Tuple[str, AsyncGenerator[str, None]]:
        """
        Export institutional or faculty-scoped overview of all sections to CSV.
        """
        analytics_service = AnalyticsService(self.db)
        overview = await analytics_service.get_overview(
            current_user=current_user,
            academic_term_id=academic_term_id,
            threshold=threshold,
        )

        await self.log_export_audit(
            user=current_user,
            report_type="OVERVIEW_SUMMARY",
            teaching_assignment_id=None,
            academic_term_id=academic_term_id,
            start_date=start_date,
            end_date=end_date,
            row_count=len(overview.sections),
        )

        safe_filename = generate_safe_filename(
            prefix="attendance_overview",
            identifier="institutional" if current_user.role == UserRole.ADMIN else "faculty",
        )

        headers = [
            "Section Code",
            "Subject Code",
            "Subject Name",
            "Faculty Name",
            "Held Sessions",
            "Enrolled Students",
            "Average Attendance Percentage",
            "Students in Shortage",
            "Delegated",
        ]

        async def csv_streamer() -> AsyncGenerator[str, None]:
            yield "\ufeff"
            buf = io.StringIO()
            writer = csv.writer(buf, lineterminator="\r\n")
            writer.writerow(headers)
            yield buf.getvalue()

            for sec in overview.sections:
                buf = io.StringIO()
                writer = csv.writer(buf, lineterminator="\r\n")
                avg_pct = f"{sec.average_attendance_percentage:.1f}%" if sec.average_attendance_percentage is not None else "N/A"
                row = [
                    sanitize_csv_cell(sec.section_code),
                    sanitize_csv_cell(sec.subject_code),
                    sanitize_csv_cell(sec.subject_name),
                    sanitize_csv_cell(sec.faculty_name),
                    sanitize_csv_cell(sec.held_sessions),
                    sanitize_csv_cell(sec.total_enrolled),
                    sanitize_csv_cell(avg_pct),
                    sanitize_csv_cell(sec.shortage_count),
                    sanitize_csv_cell("YES" if sec.is_delegated else "NO"),
                ]
                writer.writerow(row)
                yield buf.getvalue()

        return safe_filename, csv_streamer()
