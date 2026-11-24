from datetime import date, datetime, timezone
from typing import List, Optional
import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import get_settings
from src.core.exceptions import (
    AmendmentWindowExpiredError,
    AttendanceDomainError,
    EntityNotFoundError,
    OutOfScopeError,
    StaleAmendmentError,
    UnauthorizedRoleError,
)
from src.models.attendance import (
    AmendmentRole,
    AttendanceAmendmentAudit,
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    MarkSource,
)
from src.models.user import User, UserRole


class AmendmentService:
    """
    Domain service orchestrating post-finalization attendance amendments (Phase 9 / FR-027).
    Enforces:
    1. Assigned regular faculty can amend finalized attendance records within configured
       window (defaulting to 7 days).
    2. Substitute faculty are strictly excluded from post-finalization amendments.
    3. Beyond the correction window, only Administrators can make amendments.
    4. Immutable audit trail generated on every amendment with check constraints
       (status changed, reason length >= 10).
    5. Session aggregate counts and attendance percentages remain immediately consistent.
    """

    def __init__(self, db: AsyncSession, correction_window_days: Optional[int] = None):
        self.db = db
        settings = get_settings()
        self.correction_window_days = (
            correction_window_days
            if correction_window_days is not None
            else settings.ATTENDANCE_CORRECTION_WINDOW_DAYS
        )

    async def amend_attendance_record(
        self,
        session_id: uuid.UUID,
        student_user_id: uuid.UUID,
        new_status: AttendanceStatus,
        amendment_reason: str,
        current_user: User,
        eval_date: Optional[date] = None,
        client_amendment_id: Optional[uuid.UUID] = None,
        expected_previous_status: Optional[AttendanceStatus] = None,
    ) -> AttendanceAmendmentAudit:
        """
        Amend a single student's attendance record in a finalized attendance session.
        Commits audit record and updates session aggregates in an atomic transaction.
        Supports client_amendment_id for exactly-once idempotency under retries and
        expected_previous_status for optimistic concurrency protection.
        """
        # 0. Idempotency Check: if client_amendment_id already exists, return existing audit
        if client_amendment_id is not None:
            existing_audit_stmt = select(AttendanceAmendmentAudit).where(
                AttendanceAmendmentAudit.client_amendment_id == client_amendment_id
            )
            existing_audit_res = await self.db.execute(existing_audit_stmt)
            existing_audit = existing_audit_res.scalar_one_or_none()
            if existing_audit is not None:
                setattr(existing_audit, "is_already_synced", True)
                return existing_audit

        # 1. Validate amendment reason length
        cleaned_reason = (amendment_reason or "").strip()
        if len(cleaned_reason) < 10:
            raise AttendanceDomainError(
                "Amendment reason must contain at least 10 non-whitespace characters."
            )

        # 2. Fetch attendance session
        session_stmt = select(AttendanceSession).where(AttendanceSession.id == session_id)
        session_res = await self.db.execute(session_stmt)
        session = session_res.scalar_one_or_none()

        if not session:
            raise EntityNotFoundError(f"Attendance session {session_id} not found.")

        # 3. Verify session finalization status
        if session.session_status not in (AttendanceSessionStatus.FINALIZED, AttendanceSessionStatus.SYNCED):
            raise AttendanceDomainError("Cannot amend an unfinalized attendance session.")

        # 4. Enforce Amending Role & Correction Window Rules
        amendment_role: AmendmentRole

        if current_user.role == UserRole.ADMIN:
            # Administrators have global override authority inside and beyond the window
            amendment_role = AmendmentRole.ADMIN
        elif current_user.role == UserRole.FACULTY:
            # Only the regular assigned faculty holds post-finalization amendment authority
            if current_user.id != session.regular_faculty_user_id:
                # Strictly reject substitute faculty and unauthorized faculty
                raise OutOfScopeError(
                    "Substitute faculty are excluded from post-finalization amendments. "
                    "Only the assigned regular faculty or an administrator may amend attendance."
                )

            # Check correction window
            effective_date = eval_date or datetime.now(timezone.utc).date()
            elapsed_days = (effective_date - session.session_date).days

            if elapsed_days > self.correction_window_days:
                raise AmendmentWindowExpiredError(
                    f"Correction window of {self.correction_window_days} days has expired "
                    f"(elapsed: {elapsed_days} days since session on {session.session_date}). "
                    f"Administrative override required."
                )

            amendment_role = AmendmentRole.REGULAR_FACULTY
        else:
            raise UnauthorizedRoleError(
                f"User with role {current_user.role.value} is not authorized to amend attendance."
            )

        # 5. Fetch target AttendanceRecord
        record_stmt = select(AttendanceRecord).where(
            AttendanceRecord.attendance_session_id == session.id,
            AttendanceRecord.student_user_id == student_user_id,
        )
        record_res = await self.db.execute(record_stmt)
        record = record_res.scalar_one_or_none()

        if not record:
            raise EntityNotFoundError(
                f"Attendance record for student {student_user_id} not found in session {session_id}."
            )

        # 5.1 Optimistic Concurrency Check: If expected_previous_status is supplied, must match current DB status
        if expected_previous_status is not None:
            if record.attendance_status != expected_previous_status:
                raise StaleAmendmentError(
                    f"Optimistic concurrency conflict: student attendance status was changed to "
                    f"{record.attendance_status.value} (expected: {expected_previous_status.value}). Refresh required."
                )

        # 6. Validate status transition
        previous_status = record.attendance_status
        if previous_status == new_status:
            raise AttendanceDomainError(
                f"Amendment must change attendance status. Current status is already {new_status.value}."
            )

        # 7. Apply updates to AttendanceRecord
        record.attendance_status = new_status
        record.mark_source = MarkSource.MANUAL_OVERRIDE

        # 8. Recompute session aggregate counts
        if previous_status == AttendanceStatus.PRESENT:
            session.present_count = max(0, session.present_count - 1)
        elif previous_status == AttendanceStatus.ABSENT:
            session.absent_count = max(0, session.absent_count - 1)
        elif previous_status == AttendanceStatus.EXCUSED:
            session.excused_count = max(0, session.excused_count - 1)

        if new_status == AttendanceStatus.PRESENT:
            session.present_count += 1
        elif new_status == AttendanceStatus.ABSENT:
            session.absent_count += 1
        elif new_status == AttendanceStatus.EXCUSED:
            session.excused_count += 1

        # 9. Insert immutable AttendanceAmendmentAudit entry
        audit = AttendanceAmendmentAudit(
            id=uuid.uuid4(),
            client_amendment_id=client_amendment_id,
            attendance_session_id=session.id,
            student_user_id=student_user_id,
            previous_status=previous_status,
            new_status=new_status,
            amending_user_id=current_user.id,
            amendment_role=amendment_role,
            amendment_reason=cleaned_reason,
            amended_at=datetime.now(timezone.utc),
        )
        self.db.add(audit)
        await self.db.flush()
        setattr(audit, "is_already_synced", False)

        # 10. Authority Notification Routing (Matrix Rule 1)
        try:
            from src.services.notification_service import NotificationRoutingService
            await NotificationRoutingService.notify_attendance_amendment(
                db=self.db,
                session_id=session.id,
                record_id=record.id,
                student_user_id=student_user_id,
                amending_user_id=current_user.id,
                old_status=previous_status.value if hasattr(previous_status, "value") else str(previous_status),
                new_status=new_status.value if hasattr(new_status, "value") else str(new_status),
                reason=cleaned_reason,
                conducting_faculty_user_id=session.created_by_faculty_user_id,
                teaching_assignment_id=session.teaching_assignment_id,
            )
        except Exception as e:
            import logging
            logging.getLogger("klasio.notifications").warning(f"Failed to route amendment notification: {e}")

        return audit

    async def get_session_amendments(
        self, session_id: uuid.UUID
    ) -> List[AttendanceAmendmentAudit]:
        """Retrieve all immutable amendment audit rows for a given attendance session."""
        stmt = (
            select(AttendanceAmendmentAudit)
            .where(AttendanceAmendmentAudit.attendance_session_id == session_id)
            .order_by(AttendanceAmendmentAudit.amended_at.asc())
        )
        res = await self.db.execute(stmt)
        return list(res.scalars().all())

    async def get_student_amendments(
        self, student_user_id: uuid.UUID
    ) -> List[AttendanceAmendmentAudit]:
        """Retrieve all amendment audit rows for a given student across sessions."""
        stmt = (
            select(AttendanceAmendmentAudit)
            .where(AttendanceAmendmentAudit.student_user_id == student_user_id)
            .order_by(AttendanceAmendmentAudit.amended_at.desc())
        )
        res = await self.db.execute(stmt)
        return list(res.scalars().all())
