from datetime import datetime, timezone
from typing import List, Optional
import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import (
    EntityNotFoundError,
    UnauthorizedRoleError,
)
from src.models.academic import Subject
from src.models.assignment import TeachingAssignment
from src.models.attendance import (
    AttendanceRequestStatus,
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

        req = StudentAttendanceRequest(
            student_user_id=student_user.id,
            teaching_assignment_id=payload.teaching_assignment_id,
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
                session_id=getattr(req, "attendance_session_id", None),
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
        )

    async def list_student_requests(
        self,
        student_user: User,
    ) -> List[StudentAttendanceRequestResponse]:
        stmt = (
            select(StudentAttendanceRequest, Subject.name.label("subject_name"))
            .join(
                TeachingAssignment,
                StudentAttendanceRequest.teaching_assignment_id == TeachingAssignment.id,
            )
            .join(Subject, TeachingAssignment.subject_id == Subject.id)
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
            )
            for req, subject_name in rows
        ]

    async def list_reviewer_requests(
        self,
        reviewer_user: User,
        teaching_assignment_id: Optional[uuid.UUID] = None,
    ) -> List[StudentAttendanceRequestResponse]:
        scoping = ScopingService(self.db)
        permitted_ids = await scoping.get_permitted_assignment_ids(reviewer_user)

        query = (
            select(StudentAttendanceRequest, Subject.name.label("subject_name"))
            .join(
                TeachingAssignment,
                StudentAttendanceRequest.teaching_assignment_id == TeachingAssignment.id,
            )
            .join(Subject, TeachingAssignment.subject_id == Subject.id)
        )

        if reviewer_user.role != UserRole.ADMIN:
            query = query.where(StudentAttendanceRequest.teaching_assignment_id.in_(permitted_ids))

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
            )
            for req, subject_name in rows
        ]

    async def resolve_request(
        self,
        reviewer_user: User,
        request_id: uuid.UUID,
        payload: ResolveAttendanceRequest,
    ) -> StudentAttendanceRequestResponse:
        stmt = (
            select(StudentAttendanceRequest, Subject.name.label("subject_name"))
            .join(
                TeachingAssignment,
                StudentAttendanceRequest.teaching_assignment_id == TeachingAssignment.id,
            )
            .join(Subject, TeachingAssignment.subject_id == Subject.id)
            .where(StudentAttendanceRequest.id == request_id)
        )
        res = await self.db.execute(stmt)
        row = res.first()
        if not row:
            raise EntityNotFoundError(f"Attendance request {request_id} not found")

        req, subject_name = row

        scoping = ScopingService(self.db)
        permitted_ids = await scoping.get_permitted_assignment_ids(reviewer_user)
        if reviewer_user.role != UserRole.ADMIN and req.teaching_assignment_id not in permitted_ids:
            raise UnauthorizedRoleError(
                "You are not authorized to review attendance requests for this assignment"
            )

        req.status = payload.status
        req.reviewer_user_id = reviewer_user.id
        req.resolution_note = payload.resolution_note
        req.resolved_at = datetime.now(timezone.utc)

        await self.db.flush()
        await self.db.refresh(req)

        # Authority Notification Matrix Rule 5: Grievance accepted/rejected
        try:
            from src.services.notification_service import NotificationRoutingService
            ta_res = await self.db.execute(select(TeachingAssignment).where(TeachingAssignment.id == req.teaching_assignment_id))
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
        )
