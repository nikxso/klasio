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
    attendance_percentage: Optional[float] = None
    effective_start_date: date
    classes_to_recover: int = 0
    classes_can_miss: int = 0
    is_shortage: bool = False
    is_recoverable: bool = True
    threshold: float = 75.0

    model_config = ConfigDict(from_attributes=True)


class StudentWeeklyTrendPoint(BaseModel):
    period_label: str
    attendance_percentage: Optional[float] = None
    total_present: int = 0
    total_eligible: int = 0
    start_date: Optional[date] = None
    end_date: Optional[date] = None


class StudentPersonalAttendanceResponse(BaseModel):
    student_id: uuid.UUID
    academic_term_id: Optional[uuid.UUID] = None
    subjects: List[StudentSubjectAttendanceSummary]
    overall_attendance_percentage: Optional[float] = None
    total_eligible_sessions: int = 0
    total_attended_sessions: int = 0
    weekly_trend: List[StudentWeeklyTrendPoint] = []

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
    attendance_percentage: Optional[float] = None
    classes_to_recover: int = 0
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


class BulkStudentEnrollmentRow(BaseModel):
    institutional_id: str = Field(..., min_length=1, max_length=64)
    full_name: str = Field(..., min_length=1, max_length=255)
    email: str = Field(..., min_length=3, max_length=255)
    effective_start_date: Optional[date] = None


class BulkEnrollmentPreviewItem(BaseModel):
    row_index: int
    institutional_id: str
    full_name: str
    email: str
    effective_start_date: date
    is_valid: bool
    status: str
    error_message: Optional[str] = None
    student_name: Optional[str] = None
    validation_error: Optional[str] = None

    @model_validator(mode="after")
    def populate_aliases(self) -> "BulkEnrollmentPreviewItem":
        if not self.student_name:
            self.student_name = self.full_name
        if not self.validation_error and self.error_message:
            self.validation_error = self.error_message
        return self


class BulkEnrollmentPreviewRequest(BaseModel):
    academic_term_id: uuid.UUID
    class_section_id: uuid.UUID
    students: Optional[List[BulkStudentEnrollmentRow]] = None
    rows: Optional[List[BulkStudentEnrollmentRow]] = None

    @model_validator(mode="after")
    def resolve_students(self) -> "BulkEnrollmentPreviewRequest":
        if self.students is None:
            self.students = self.rows or []
        return self


class BulkEnrollmentPreviewResponse(BaseModel):
    total_rows: int
    valid_count: int
    error_count: int
    existing_user_count: int
    new_user_count: int
    preview_rows: List[BulkEnrollmentPreviewItem]
    total_submitted: Optional[int] = None
    duplicate_count: Optional[int] = None
    new_accounts_count: Optional[int] = None
    rejected_count: Optional[int] = None

    @model_validator(mode="after")
    def populate_response_aliases(self) -> "BulkEnrollmentPreviewResponse":
        if self.total_submitted is None:
            self.total_submitted = self.total_rows
        if self.duplicate_count is None:
            self.duplicate_count = self.existing_user_count
        if self.new_accounts_count is None:
            self.new_accounts_count = self.new_user_count
        if self.rejected_count is None:
            self.rejected_count = self.error_count
        return self


class BulkEnrollmentExecuteRequest(BaseModel):
    academic_term_id: uuid.UUID
    class_section_id: uuid.UUID
    students: Optional[List[BulkStudentEnrollmentRow]] = None
    rows: Optional[List[BulkStudentEnrollmentRow]] = None
    create_missing_accounts: Optional[bool] = True

    @model_validator(mode="after")
    def resolve_students(self) -> "BulkEnrollmentExecuteRequest":
        if self.students is None:
            self.students = self.rows or []
        return self


class BulkEnrollmentExecuteResponse(BaseModel):
    success: bool
    enrolled_count: int
    failed_count: int
    errors: List[BulkEnrollmentPreviewItem] = []
    created_enrollments_count: Optional[int] = None
    created_users_count: Optional[int] = None

    @model_validator(mode="after")
    def populate_counts(self) -> "BulkEnrollmentExecuteResponse":
        if self.created_enrollments_count is None:
            self.created_enrollments_count = self.enrolled_count
        return self


class SectionRosterStudentItem(BaseModel):
    enrollment_id: uuid.UUID
    student_user_id: uuid.UUID
    institutional_id: str
    student_name: str
    email: str
    effective_start_date: date
    effective_end_date: Optional[date] = None
    enrollment_status: EnrollmentStatus
    face_registration_state: str = "UNREGISTERED"

    model_config = ConfigDict(from_attributes=True)


class SectionRosterResponse(BaseModel):
    section_id: uuid.UUID
    section_code: str
    academic_term_id: uuid.UUID
    academic_term_name: str
    department_name: str
    total_enrolled: int
    active_count: int
    students: List[SectionRosterStudentItem]

    model_config = ConfigDict(from_attributes=True)


class StudentCurrentEnrollmentResponse(BaseModel):
    student_user_id: uuid.UUID
    section_id: uuid.UUID
    section_code: str
    program_name: Optional[str] = None
    department_name: str
    academic_term_id: uuid.UUID
    academic_term_name: str
    academic_year: str
    enrollment_status: EnrollmentStatus
    effective_start_date: date

    model_config = ConfigDict(from_attributes=True)

