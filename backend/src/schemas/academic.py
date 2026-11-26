from datetime import date, datetime
import uuid
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field, model_validator
from src.models.academic import TermStatus


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
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ClassSectionCreate(BaseModel):
    section_code: str = Field(..., max_length=64)
    department_id: uuid.UUID
    academic_term_id: uuid.UUID
    cohort_year: int = Field(..., ge=2000, le=2100)


class ClassSectionUpdate(BaseModel):
    section_code: Optional[str] = Field(None, max_length=64)
    cohort_year: Optional[int] = Field(None, ge=2000, le=2100)


class ClassSectionResponse(ClassSectionCreate):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
