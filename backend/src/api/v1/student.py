import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.permissions import require_student
from src.database import get_db_session
from src.models.user import User
from src.schemas.enrollment import (
    StudentPersonalAttendanceResponse,
    StudentSubjectHistoryResponse,
)
from src.schemas.request import (
    CreateAttendanceRequest,
    StudentAttendanceRequestResponse,
)
from src.services.enrollment_service import EnrollmentService
from src.services.request_service import RequestService

router = APIRouter(prefix="/api/v1/student", tags=["Student Attendance Portal"])


@router.get("/attendance", response_model=StudentPersonalAttendanceResponse)
async def get_student_personal_attendance(
    academic_term_id: Optional[uuid.UUID] = Query(None),
    current_student: User = Depends(require_student),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Retrieve personal attendance summary and metrics for the authenticated student.
    Strictly scoped to current_student.id. Prior sessions before effective_start_date are excluded.
    """
    enrollment_service = EnrollmentService(db)
    return await enrollment_service.calculate_student_personal_attendance(
        student_user_id=current_student.id,
        academic_term_id=academic_term_id,
    )


@router.get("/subjects/{teaching_assignment_id}/history", response_model=StudentSubjectHistoryResponse)
async def get_student_subject_history(
    teaching_assignment_id: uuid.UUID,
    current_student: User = Depends(require_student),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Retrieve chronological attendance history for a specific subject/teaching assignment
    for the authenticated student. Strictly scoped to current_student.id and enrollment dates.
    """
    enrollment_service = EnrollmentService(db)
    return await enrollment_service.get_student_subject_history(
        student_user_id=current_student.id,
        teaching_assignment_id=teaching_assignment_id,
    )


@router.post(
    "/requests",
    response_model=StudentAttendanceRequestResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Submit student attendance grievance or mistake report",
)
async def submit_student_attendance_request(
    payload: CreateAttendanceRequest,
    current_student: User = Depends(require_student),
    db: AsyncSession = Depends(get_db_session),
):
    service = RequestService(db)
    return await service.submit_request(current_student, payload)


@router.get(
    "/requests",
    response_model=List[StudentAttendanceRequestResponse],
    summary="List attendance grievance requests submitted by authenticated student",
)
async def list_student_attendance_requests(
    current_student: User = Depends(require_student),
    db: AsyncSession = Depends(get_db_session),
):
    service = RequestService(db)
    return await service.list_student_requests(current_student)

