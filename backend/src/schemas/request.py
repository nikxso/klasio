from datetime import date, datetime
from typing import Optional
import uuid
from pydantic import BaseModel, ConfigDict, Field

from src.models.attendance import AttendanceRequestStatus


class CreateAttendanceRequest(BaseModel):
    teaching_assignment_id: uuid.UUID
    session_date: date
    student_note: str = Field(..., min_length=3, max_length=1000)
    attendance_session_id: Optional[uuid.UUID] = None


class ResolveAttendanceRequest(BaseModel):
    status: AttendanceRequestStatus
    resolution_note: str = Field(..., min_length=2, max_length=1000)


class StudentAttendanceRequestResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    student_user_id: uuid.UUID
    teaching_assignment_id: uuid.UUID
    session_date: date
    student_note: str
    status: AttendanceRequestStatus
    reviewer_user_id: Optional[uuid.UUID] = None
    resolution_note: Optional[str] = None
    created_at: datetime
    resolved_at: Optional[datetime] = None
    subject_name: Optional[str] = None
    student_name: Optional[str] = None
    student_institutional_id: Optional[str] = None
    student_email: Optional[str] = None
    attendance_session_id: Optional[uuid.UUID] = None
    attendance_adjusted: Optional[bool] = None
