from datetime import date, datetime, time
import uuid
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field, model_validator
from src.models.academic import TermStatus


class CampusCreate(BaseModel):
    code: str = Field(..., max_length=32)
    name: str = Field(..., max_length=255)


class CampusUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
    status: Optional[str] = None


class CampusResponse(CampusCreate):
    id: uuid.UUID
    status: str = "ACTIVE"
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DepartmentCreate(BaseModel):
    code: str = Field(..., max_length=32)
    name: str = Field(..., max_length=255)


class DepartmentUpdate(BaseModel):
    code: Optional[str] = Field(None, max_length=32)
    name: Optional[str] = Field(None, max_length=255)


class DepartmentResponse(DepartmentCreate):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ProgramCreate(BaseModel):
    department_id: uuid.UUID
    code: str = Field(..., max_length=64)
    name: str = Field(..., max_length=255)
    is_active: bool = True


class ProgramUpdate(BaseModel):
    code: Optional[str] = Field(None, max_length=64)
    name: Optional[str] = Field(None, max_length=255)
    is_active: Optional[bool] = None


class ProgramResponse(ProgramCreate):
    id: uuid.UUID
    department_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AcademicTermCreate(BaseModel):
    code: str = Field(..., max_length=64)
    name: str = Field(..., max_length=255)
    academic_year: str = Field(..., max_length=16)
    start_date: date
    end_date: date
    status: TermStatus = TermStatus.UPCOMING

    @model_validator(mode="after")
    def validate_term_dates(self) -> "AcademicTermCreate":
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class AcademicTermResponse(AcademicTermCreate):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SubjectCreate(BaseModel):
    code: str = Field(..., max_length=32)
    name: str = Field(..., max_length=255)
    department_id: uuid.UUID
    credits: int = Field(default=3, ge=1, le=10)
    is_active: bool = True


class SubjectUpdate(BaseModel):
    code: Optional[str] = Field(None, max_length=32)
    name: Optional[str] = Field(None, max_length=255)
    credits: Optional[int] = Field(None, ge=1, le=10)
    is_active: Optional[bool] = None


class SubjectResponse(SubjectCreate):
    id: uuid.UUID
    department_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ClassSectionCreate(BaseModel):
    section_code: str = Field(..., max_length=64)
    department_id: uuid.UUID
    academic_term_id: uuid.UUID
    cohort_year: int = Field(..., ge=2000, le=2100)
    program_id: Optional[uuid.UUID] = None
    campus_id: Optional[uuid.UUID] = None


class ClassSectionUpdate(BaseModel):
    section_code: Optional[str] = Field(None, max_length=64)
    cohort_year: Optional[int] = Field(None, ge=2000, le=2100)
    program_id: Optional[uuid.UUID] = None


class ClassSectionResponse(ClassSectionCreate):
    id: uuid.UUID
    department_name: Optional[str] = None
    term_name: Optional[str] = None
    program_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AcademicPeriodCreate(BaseModel):
    period_number: int = Field(..., ge=1, le=20)
    name: str = Field(..., max_length=64)
    start_time: time
    end_time: time
    is_break: bool = False
    is_active: bool = True

    @model_validator(mode="after")
    def validate_period_times(self) -> "AcademicPeriodCreate":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be strictly after start_time")
        return self


class AcademicPeriodUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=64)
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    is_break: Optional[bool] = None
    is_active: Optional[bool] = None


class AcademicPeriodResponse(AcademicPeriodCreate):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TimetableEntryCreate(BaseModel):
    academic_term_id: uuid.UUID
    class_section_id: uuid.UUID
    teaching_assignment_id: uuid.UUID
    academic_period_id: uuid.UUID
    day_of_week: int = Field(..., ge=1, le=7, description="1=Monday ... 7=Sunday")
    room_number: str = Field(default="TBD", max_length=64)
    is_active: bool = True


class TimetableEntryUpdate(BaseModel):
    room_number: Optional[str] = Field(None, max_length=64)
    academic_period_id: Optional[uuid.UUID] = None
    day_of_week: Optional[int] = Field(None, ge=1, le=7)
    is_active: Optional[bool] = None


class TimetableEntryResponse(TimetableEntryCreate):
    id: uuid.UUID
    subject_code: Optional[str] = None
    subject_name: Optional[str] = None
    section_code: Optional[str] = None
    period_name: Optional[str] = None
    period_number: Optional[int] = None
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    faculty_user_id: Optional[uuid.UUID] = None
    faculty_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
