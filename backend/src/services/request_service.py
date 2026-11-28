from datetime import datetime, timezone
from typing import List, Optional
import uuid
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import (
    EntityNotFoundError,
    UnauthorizedRoleError,
)
from src.models.academic import Subject
from src.models.assignment import TeachingAssignment
from src.models.attendance import (
    AttendanceAmendmentAudit,
    AttendanceRecord,
    AttendanceRequestStatus,
    AttendanceSession,
    AttendanceStatus,
    MarkSource,
    AmendmentRole,
    StudentAttendanceRequest,
)
from src.models.user import User, UserRole
from src.schemas.request import (
    CreateAttendanceRequest,
    ResolveAttendanceRequest,
    StudentAttendanceRequestResponse,
)
from src.services.scoping_service import ScopingService


class RequestService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def submit_request(
        self,
        student_user: User,
        payload: CreateAttendanceRequest,
    ) -> StudentAttendanceRequestResponse:
        # Check assignment exists
        stmt = (
            select(TeachingAssignment, Subject.name.label("subject_name"))
            .join(Subject, TeachingAssignment.subject_id == Subject.id)
            .where(TeachingAssignment.id == payload.teaching_assignment_id)
        )
        res = await self.db.execute(stmt)
        row = res.first()
        if not row:
            raise EntityNotFoundError(f"Teaching assignment {payload.teaching_assignment_id} not found")

        assignment, subject_name = row

        # Auto-correlate with an existing attendance session on that date if not provided
        matched_session_id = payload.attendance_session_id
        if not matched_session_id:
            sess_stmt = (
                select(AttendanceSession.id)
                .where(
                    and_(
                        AttendanceSession.teaching_assignment_id == payload.teaching_assignment_id,
                        AttendanceSession.session_date == payload.session_date,
                    )
                )
                .order_by(AttendanceSession.created_at.desc())
            )
            sess_res = await self.db.execute(sess_stmt)
            matched_session_id = sess_res.scalar_one_or_none()

        req = StudentAttendanceRequest(
            student_user_id=student_user.id,
            teaching_assignment_id=payload.teaching_assignment_id,
            attendance_session_id=matched_session_id,
            session_date=payload.session_date,
            student_note=payload.student_note,
            status=AttendanceRequestStatus.PENDING,
        )
        self.db.add(req)
        await self.db.flush()
        await self.db.refresh(req)

        # Notify conducting/assigned faculty via Authority Notification Engine
        try:
            from src.services.notification_service import NotificationRoutingService
            await NotificationRoutingService.notify_grievance_submitted(
                db=self.db,
                request_id=req.id,
                student_user_id=student_user.id,
                conducting_faculty_user_id=assignment.faculty_user_id,
                session_id=matched_session_id,
                reason=payload.student_note or "Attendance grievance submitted",
            )
        except Exception as e:
            import logging
            logging.getLogger("klasio.notifications").warning(f"Failed to route grievance submission notification: {e}")

        return StudentAttendanceRequestResponse(
            id=req.id,
            student_user_id=req.student_user_id,
            teaching_assignment_id=req.teaching_assignment_id,
            session_date=req.session_date,
            student_note=req.student_note,
            status=req.status,
            reviewer_user_id=req.reviewer_user_id,
            resolution_note=req.resolution_note,
            created_at=req.created_at,
            resolved_at=req.resolved_at,
            subject_name=subject_name,
            student_name=student_user.full_name,
            student_institutional_id=student_user.institutional_id,
            student_email=student_user.email,
            attendance_session_id=matched_session_id,
        )

    async def list_student_requests(
        self,
        student_user: User,
    ) -> List[StudentAttendanceRequestResponse]:
        stmt = (
            select(
                StudentAttendanceRequest,
                Subject.name.label("subject_name"),
                User.full_name.label("student_name"),
                User.institutional_id.label("student_institutional_id"),
                User.email.label("student_email"),
            )
            .join(
                TeachingAssignment,
                StudentAttendanceRequest.teaching_assignment_id == TeachingAssignment.id,
            )
            .join(Subject, TeachingAssignment.subject_id == Subject.id)
            .join(User, StudentAttendanceRequest.student_user_id == User.id)
            .where(StudentAttendanceRequest.student_user_id == student_user.id)
            .order_by(StudentAttendanceRequest.created_at.desc())
        )
        res = await self.db.execute(stmt)
        rows = res.all()

        return [
            StudentAttendanceRequestResponse(
                id=req.id,
                student_user_id=req.student_user_id,
                teaching_assignment_id=req.teaching_assignment_id,
                session_date=req.session_date,
                student_note=req.student_note,
                status=req.status,
                reviewer_user_id=req.reviewer_user_id,
                resolution_note=req.resolution_note,
                created_at=req.created_at,
                resolved_at=req.resolved_at,
                subject_name=subject_name,
                student_name=student_name,
                student_institutional_id=student_institutional_id,
                student_email=student_email,
                attendance_session_id=req.attendance_session_id,
            )
            for req, subject_name, student_name, student_institutional_id, student_email in rows
        ]

    async def list_reviewer_requests(
        self,
        reviewer_user: User,
        teaching_assignment_id: Optional[uuid.UUID] = None,
    ) -> List[StudentAttendanceRequestResponse]:
        scoping = ScopingService(self.db)
        permitted_ids = await scoping.get_permitted_assignment_ids(reviewer_user)

        query = (
            select(
                StudentAttendanceRequest,
                Subject.name.label("subject_name"),
                User.full_name.label("student_name"),
                User.institutional_id.label("student_institutional_id"),
                User.email.label("student_email"),
            )
            .join(
                TeachingAssignment,
                StudentAttendanceRequest.teaching_assignment_id == TeachingAssignment.id,
            )
            .join(Subject, TeachingAssignment.subject_id == Subject.id)
            .join(User, StudentAttendanceRequest.student_user_id == User.id)
        )

        if reviewer_user.role != UserRole.ADMIN:
            if permitted_ids:
                query = query.where(
                    or_(
                        StudentAttendanceRequest.teaching_assignment_id.in_(permitted_ids),
                        TeachingAssignment.faculty_user_id == reviewer_user.id,
                    )
                )
            else:
                query = query.where(TeachingAssignment.faculty_user_id == reviewer_user.id)

        if teaching_assignment_id:
            query = query.where(
                StudentAttendanceRequest.teaching_assignment_id == teaching_assignment_id
            )

        query = query.order_by(StudentAttendanceRequest.created_at.desc())
        res = await self.db.execute(query)
        rows = res.all()

        return [
            StudentAttendanceRequestResponse(
                id=req.id,
                student_user_id=req.student_user_id,
                teaching_assignment_id=req.teaching_assignment_id,
                session_date=req.session_date,
                student_note=req.student_note,
                status=req.status,
                reviewer_user_id=req.reviewer_user_id,
                resolution_note=req.resolution_note,
                created_at=req.created_at,
                resolved_at=req.resolved_at,
                subject_name=subject_name,
                student_name=student_name,
                student_institutional_id=student_institutional_id,
                student_email=student_email,
                attendance_session_id=req.attendance_session_id,
            )
            for req, subject_name, student_name, student_institutional_id, student_email in rows
        ]

    async def resolve_request(
        self,
        reviewer_user: User,
        request_id: uuid.UUID,
        payload: ResolveAttendanceRequest,
    ) -> StudentAttendanceRequestResponse:
        stmt = (
            select(
                StudentAttendanceRequest,
                Subject.name.label("subject_name"),
                User.full_name.label("student_name"),
                User.institutional_id.label("student_institutional_id"),
                User.email.label("student_email"),
            )
            .join(
                TeachingAssignment,
                StudentAttendanceRequest.teaching_assignment_id == TeachingAssignment.id,
            )
            .join(Subject, TeachingAssignment.subject_id == Subject.id)
            .join(User, StudentAttendanceRequest.student_user_id == User.id)
            .where(StudentAttendanceRequest.id == request_id)
        )
        res = await self.db.execute(stmt)
        row = res.first()
        if not row:
            raise EntityNotFoundError(f"Attendance request {request_id} not found")

        req, subject_name, student_name, student_institutional_id, student_email = row

        scoping = ScopingService(self.db)
        permitted_ids = await scoping.get_permitted_assignment_ids(reviewer_user)
        if (
            reviewer_user.role != UserRole.ADMIN
            and req.teaching_assignment_id not in permitted_ids
        ):
            # Also allow the direct faculty owner even if the assignment was deactivated
            assign_res = await self.db.execute(
                select(TeachingAssignment.faculty_user_id).where(
                    TeachingAssignment.id == req.teaching_assignment_id
                )
            )
            owner_id = assign_res.scalar_one_or_none()
            if owner_id != reviewer_user.id:
                raise UnauthorizedRoleError(
                    "You are not authorized to review attendance requests for this assignment"
                )

        req.status = payload.status
        req.reviewer_user_id = reviewer_user.id
        req.resolution_note = payload.resolution_note
        req.resolved_at = datetime.now(timezone.utc)

        attendance_adjusted = False
        if payload.status == AttendanceRequestStatus.APPROVED:
            attendance_adjusted = await self._adjust_attendance_on_approval(
                req=req,
                reviewer_user=reviewer_user,
                resolution_note=payload.resolution_note,
            )

        await self.db.flush()
        await self.db.refresh(req)

        # Authority Notification Matrix Rule 5: Grievance accepted/rejected
        try:
            from src.services.notification_service import NotificationRoutingService
            ta_res = await self.db.execute(
                select(TeachingAssignment).where(TeachingAssignment.id == req.teaching_assignment_id)
            )
            ta = ta_res.scalar_one_or_none()
            regular_fac = ta.faculty_user_id if ta else reviewer_user.id
            await NotificationRoutingService.notify_grievance_resolved(
                db=self.db,
                request_id=req.id,
                student_user_id=req.student_user_id,
                regular_faculty_user_id=regular_fac,
                conducting_faculty_user_id=reviewer_user.id if reviewer_user.id != regular_fac else None,
                status=payload.status.value,
                resolution_notes=payload.resolution_note or "",
            )
        except Exception as e:
            import logging
            logging.getLogger("klasio.notifications").warning(f"Failed to route grievance resolution notification: {e}")

        return StudentAttendanceRequestResponse(
            id=req.id,
            student_user_id=req.student_user_id,
            teaching_assignment_id=req.teaching_assignment_id,
            session_date=req.session_date,
            student_note=req.student_note,
            status=req.status,
            reviewer_user_id=req.reviewer_user_id,
            resolution_note=req.resolution_note,
            created_at=req.created_at,
            resolved_at=req.resolved_at,
            subject_name=subject_name,
            student_name=student_name,
            student_institutional_id=student_institutional_id,
            student_email=student_email,
            attendance_session_id=req.attendance_session_id,
            attendance_adjusted=attendance_adjusted,
        )

    async def _adjust_attendance_on_approval(
        self,
        req: StudentAttendanceRequest,
        reviewer_user: User,
        resolution_note: str,
    ) -> bool:
        """
        Adjust attendance record for student when request is APPROVED:
        1. Locate attendance session for teaching_assignment_id on session_date.
        2. If record exists: update attendance_status to PRESENT, mark_source to MANUAL_OVERRIDE.
        3. If record doesn't exist: create AttendanceRecord with status PRESENT.
        4. Recompute session counters (present_count, absent_count).
        5. Insert AttendanceAmendmentAudit for immutable provenance.
        """
        session_stmt = select(AttendanceSession).where(
            and_(
                AttendanceSession.teaching_assignment_id == req.teaching_assignment_id,
                AttendanceSession.session_date == req.session_date,
            )
        )
        if req.attendance_session_id:
            session_stmt = session_stmt.where(AttendanceSession.id == req.attendance_session_id)

        session_res = await self.db.execute(session_stmt)
        sessions = session_res.scalars().all()

        if not sessions:
            return False

        adjusted = False
        for session in sessions:
            rec_stmt = select(AttendanceRecord).where(
                and_(
                    AttendanceRecord.attendance_session_id == session.id,
                    AttendanceRecord.student_user_id == req.student_user_id,
                )
            )
            rec_res = await self.db.execute(rec_stmt)
            record = rec_res.scalar_one_or_none()

            previous_status = AttendanceStatus.ABSENT
            if record:
                previous_status = record.attendance_status
                if record.attendance_status != AttendanceStatus.PRESENT:
                    record.attendance_status = AttendanceStatus.PRESENT
                    record.mark_source = MarkSource.MANUAL_OVERRIDE

                    if previous_status == AttendanceStatus.ABSENT:
                        session.absent_count = max(0, session.absent_count - 1)
                    elif previous_status == AttendanceStatus.EXCUSED:
                        session.excused_count = max(0, session.excused_count - 1)
                    session.present_count += 1
                    adjusted = True
            else:
                record = AttendanceRecord(
                    id=uuid.uuid4(),
                    institution_id=session.institution_id,
                    attendance_session_id=session.id,
                    student_user_id=req.student_user_id,
                    attendance_status=AttendanceStatus.PRESENT,
                    mark_source=MarkSource.MANUAL_OVERRIDE,
                    recorded_at=datetime.now(timezone.utc),
                )
                self.db.add(record)
                session.records_count += 1
                session.present_count += 1
                adjusted = True

            if previous_status != AttendanceStatus.PRESENT:
                clean_reason = f"Grievance Approved: {resolution_note.strip()}"
                if len(clean_reason) < 10:
                    clean_reason = f"Grievance Approved - Attendance corrected: {resolution_note.strip()}"

                audit = AttendanceAmendmentAudit(
                    id=uuid.uuid4(),
                    institution_id=session.institution_id,
                    attendance_session_id=session.id,
                    student_user_id=req.student_user_id,
                    previous_status=previous_status,
                    new_status=AttendanceStatus.PRESENT,
                    amending_user_id=reviewer_user.id,
                    amendment_role=(
                        AmendmentRole.ADMIN
                        if reviewer_user.role == UserRole.ADMIN
                        else AmendmentRole.REGULAR_FACULTY
                    ),
                    amendment_reason=clean_reason,
                    amended_at=datetime.now(timezone.utc),
                )
                self.db.add(audit)

        return adjusted
