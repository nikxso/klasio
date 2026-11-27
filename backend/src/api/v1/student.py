import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.permissions import require_student
from src.database import get_db_session
from src.models.user import User
from pydantic import BaseModel
from src.schemas.enrollment import (
    StudentPersonalAttendanceResponse,
    StudentSubjectHistoryResponse,
    StudentCurrentEnrollmentResponse,
)
from src.schemas.request import (
    CreateAttendanceRequest,
    StudentAttendanceRequestResponse,
)
from src.services.enrollment_service import EnrollmentService
from src.services.request_service import RequestService

router = APIRouter(prefix="/api/v1/student", tags=["Student Attendance Portal"])


@router.get("/enrollment/current", response_model=Optional[StudentCurrentEnrollmentResponse], summary="Get student's current active class section and academic term")
async def get_student_current_enrollment(
    current_student: User = Depends(require_student),
    db: AsyncSession = Depends(get_db_session),
):
    enrollment_service = EnrollmentService(db)
    return await enrollment_service.get_student_current_enrollment(current_student.id)


@router.get("/timetable/weekly", summary="Get student's weekly timetable schedule")
async def get_student_weekly_timetable(
    current_student: User = Depends(require_student),
    db: AsyncSession = Depends(get_db_session),
):
    from src.services.timetable_service import TimetableService
    service = TimetableService(db)
    return await service.get_student_weekly_schedule(current_student.id)


class StudentDailySessionItem(BaseModel):
    session_id: uuid.UUID
    session_date: str
    period_slot: int
    time_slot: str
    subject_code: str
    subject_name: str
    faculty_name: str
    attendance_status: str
    applicability_status: str = "COUNTED"
    status_reason: Optional[str] = None


@router.get("/attendance/calendar", response_model=List[StudentDailySessionItem], summary="Get chronological sessions for student calendar")
async def get_student_calendar_attendance(
    academic_term_id: Optional[uuid.UUID] = Query(None),
    current_student: User = Depends(require_student),
    db: AsyncSession = Depends(get_db_session),
):
    from src.models.enrollment import StudentEnrollment
    from src.models.assignment import TeachingAssignment
    from src.models.attendance import AttendanceSession, AttendanceRecord, AttendanceStatus, AttendanceSessionStatus
    from sqlalchemy import and_, select
    from sqlalchemy.orm import selectinload

    enr_stmt = select(StudentEnrollment).where(
        StudentEnrollment.student_user_id == current_student.id,
    )
    if academic_term_id:
        enr_stmt = enr_stmt.where(StudentEnrollment.academic_term_id == academic_term_id)
    enr_res = await db.execute(enr_stmt)
    enrollments = enr_res.scalars().all()
    if not enrollments:
        return []

    section_ids = [e.class_section_id for e in enrollments]

    ta_stmt = (
        select(TeachingAssignment)
        .options(
            selectinload(TeachingAssignment.subject),
            selectinload(TeachingAssignment.faculty_user),
        )
        .where(TeachingAssignment.class_section_id.in_(section_ids))
    )
    ta_res = await db.execute(ta_stmt)
    assignments = {ta.id: ta for ta in ta_res.scalars().all()}
    if not assignments:
        return []

    sess_stmt = (
        select(AttendanceSession)
        .where(
            and_(
                AttendanceSession.teaching_assignment_id.in_(list(assignments.keys())),
                AttendanceSession.session_status.in_([AttendanceSessionStatus.FINALIZED, AttendanceSessionStatus.SYNCED]),
            )
        )
        .order_by(AttendanceSession.session_date.desc(), AttendanceSession.period_slot_or_sequence.asc())
    )
    sess_res = await db.execute(sess_stmt)
    all_sessions = sess_res.scalars().all()

    applicable_sessions = []
    for s in all_sessions:
        ta = assignments.get(s.teaching_assignment_id)
        if not ta:
            continue
        for enr in enrollments:
            if enr.class_section_id == ta.class_section_id and s.session_date >= enr.effective_start_date and (
                enr.effective_end_date is None or s.session_date <= enr.effective_end_date
            ):
                applicable_sessions.append(s)
                break

    if not applicable_sessions:
        return []

    sess_ids = [s.id for s in applicable_sessions]
    rec_stmt = select(AttendanceRecord).where(
        and_(
            AttendanceRecord.attendance_session_id.in_(sess_ids),
            AttendanceRecord.student_user_id == current_student.id,
        )
    )
    rec_res = await db.execute(rec_stmt)
    rec_map = {r.attendance_session_id: r for r in rec_res.scalars().all()}

    TIME_SLOTS = {
        1: "09:00 – 10:00 AM",
        2: "10:00 – 11:00 AM",
        3: "11:15 – 12:15 PM",
        4: "01:00 – 02:00 PM",
        5: "02:00 – 03:00 PM",
        6: "03:15 – 04:15 PM",
    }

    result = []
    for s in applicable_sessions:
        ta = assignments.get(s.teaching_assignment_id)
        if not ta:
            continue
        rec = rec_map.get(s.id)
        app_val = s.applicability_status.value if hasattr(s.applicability_status, "value") else str(s.applicability_status)
        if app_val == "CANCELLED":
            status_val = "CANCELLED"
        elif app_val == "EXEMPT":
            status_val = "EXCUSED"
        else:
            status_val = rec.attendance_status.value if rec else AttendanceStatus.ABSENT.value

        result.append(
            StudentDailySessionItem(
                session_id=s.id,
                session_date=s.session_date.isoformat(),
                period_slot=s.period_slot_or_sequence,
                time_slot=TIME_SLOTS.get(s.period_slot_or_sequence, f"Period {s.period_slot_or_sequence}"),
                subject_code=ta.subject.code if ta.subject else "SUB",
                subject_name=ta.subject.name if ta.subject else "Subject",
                faculty_name=ta.faculty_user.full_name if ta.faculty_user else "Faculty",
                attendance_status=status_val,
                applicability_status=app_val,
                status_reason=s.status_reason,
            )
        )

    return result


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

