from datetime import date, datetime
import enum
import uuid
from typing import List, Optional
from pydantic import BaseModel, ConfigDict, Field, model_validator


class FaceRegistrationState(str, enum.Enum):
    UNREGISTERED = "UNREGISTERED"
    PENDING = "PENDING"
    REGISTERED = "REGISTERED"


class DelegationDetails(BaseModel):
    delegation_id: uuid.UUID
    regular_faculty_name: str
    valid_from: date
    valid_to: date


class FacultyTeachingAssignment(BaseModel):
    teaching_assignment_id: uuid.UUID
    class_section_id: uuid.UUID
    section_code: str
    subject_id: uuid.UUID
    subject_code: str
    subject_name: str
    academic_term_id: uuid.UUID
    term_name: str
    is_delegated: bool = False
    delegation_details: Optional[DelegationDetails] = None
    held_count: int = 0
    average_attendance_pct: Optional[float] = None
    students_below_threshold_count: int = 0

    model_config = ConfigDict(from_attributes=True)


class TeachingAssignmentCreate(BaseModel):
    faculty_user_id: uuid.UUID
    class_section_id: uuid.UUID
    subject_id: uuid.UUID
    academic_term_id: uuid.UUID
    teaching_group: str = Field(default="DEFAULT", max_length=64)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    is_active: bool = True


class TeachingAssignmentUpdate(BaseModel):
    faculty_user_id: Optional[uuid.UUID] = None
    teaching_group: Optional[str] = Field(None, max_length=64)
    assignment_status: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    is_active: Optional[bool] = None


class TeachingAssignmentResponse(TeachingAssignmentCreate):
    id: uuid.UUID
    assignment_status: str = "ACTIVE"
    subject_code: Optional[str] = None
    subject_name: Optional[str] = None
    section_code: Optional[str] = None
    faculty_name: Optional[str] = None
    created_by_user_id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DelegationStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"
    REVOKED = "REVOKED"


class CreateDelegationRequest(BaseModel):
    substitute_faculty_user_id: uuid.UUID
    start_date: date
    end_date: date
    delegation_reason: str = Field(..., min_length=5)

    @model_validator(mode="after")
    def validate_delegation_dates(self) -> "CreateDelegationRequest":
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class RevokeDelegationRequest(BaseModel):
    revocation_reason: str = Field(..., min_length=3)


class SubstituteDelegationResponse(BaseModel):
    id: uuid.UUID
    teaching_assignment_id: uuid.UUID
    regular_faculty_user_id: uuid.UUID
    substitute_faculty_user_id: uuid.UUID
    start_date: date
    end_date: date
    delegation_reason: str
    status: DelegationStatus
    created_by_user_id: uuid.UUID
    revoked_by_user_id: Optional[uuid.UUID] = None
    revoked_at: Optional[datetime] = None
    revocation_reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class RosterStudentItem(BaseModel):
    student_user_id: uuid.UUID
    institutional_id: str
    student_name: str
    effective_start_date: date
    face_registration_state: FaceRegistrationState = FaceRegistrationState.UNREGISTERED


class ClassRosterResponse(BaseModel):
    teaching_assignment_id: uuid.UUID
    session_date: date
    eligible_students: List[RosterStudentItem]
    total_eligible_count: int
