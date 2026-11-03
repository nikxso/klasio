from datetime import date, datetime
import uuid
from typing import List, Optional
from pydantic import BaseModel, ConfigDict, Field, model_validator

from src.models.attendance import AttendanceStatus, SessionApplicability, MarkSource
from src.models.enrollment import EnrollmentStatus


class StudentEnrollmentCreate(BaseModel):
    student_user_id: uuid.UUID
    class_section_id: uuid.UUID
    academic_term_id: uuid.UUID
    effective_start_date: date
    effective_end_date: Optional[date] = None
    enrollment_status: EnrollmentStatus = EnrollmentStatus.ACTIVE

    @model_validator(mode="after")
    def validate_dates(self) -> "StudentEnrollmentCreate":
        if self.effective_end_date and self.effective_end_date < self.effective_start_date:
            raise ValueError("effective_end_date must be on or after effective_start_date")
        return self


class StudentEnrollmentResponse(StudentEnrollmentCreate):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class StudentSubjectAttendanceSummary(BaseModel):
    subject_id: uuid.UUID
    teaching_assignment_id: uuid.UUID
    subject_code: str
    subject_name: str
    faculty_name: str
    total_eligible_sessions: int
    attended_sessions: int
    attendance_percentage: float
    effective_start_date: date
    classes_to_recover: Optional[int] = None
    classes_can_miss: int = 0
    is_shortage: bool = False
    is_recoverable: bool = True
    threshold: float = 75.0

    model_config = ConfigDict(from_attributes=True)


class StudentPersonalAttendanceResponse(BaseModel):
    student_id: uuid.UUID
    academic_term_id: Optional[uuid.UUID] = None
    subjects: List[StudentSubjectAttendanceSummary]
    overall_attendance_percentage: float

    model_config = ConfigDict(from_attributes=True)


class StudentSessionHistoryItem(BaseModel):
    session_id: uuid.UUID
    session_date: date
    period_slot_or_sequence: int
    attendance_status: AttendanceStatus
    applicability_status: SessionApplicability
    mark_source: Optional[MarkSource] = None
    status_reason: Optional[str] = None
    recorded_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class StudentSubjectHistoryResponse(BaseModel):
    teaching_assignment_id: uuid.UUID
    subject_id: uuid.UUID
    subject_code: str
    subject_name: str
    faculty_name: str
    total_eligible_sessions: int
    attended_sessions: int
    attendance_percentage: float
    classes_to_recover: Optional[int] = None
    classes_can_miss: int = 0
    is_shortage: bool = False
    is_recoverable: bool = True
    threshold: float = 75.0
    records: List[StudentSessionHistoryItem]

    model_config = ConfigDict(from_attributes=True)


class StudentTransferRequest(BaseModel):
    student_user_id: uuid.UUID
    new_class_section_id: uuid.UUID
    transfer_date: date
    current_class_section_id: Optional[uuid.UUID] = None


class StudentTransferResponse(BaseModel):
    student_user_id: uuid.UUID
    transfer_date: date
    previous_enrollment: StudentEnrollmentResponse
    new_enrollment: StudentEnrollmentResponse

    model_config = ConfigDict(from_attributes=True)
