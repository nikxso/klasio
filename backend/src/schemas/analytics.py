from datetime import date
from typing import List, Optional
import uuid
from pydantic import BaseModel, ConfigDict, Field


class WeeklyTrendPoint(BaseModel):
    period_label: str
    start_date: date
    end_date: date
    held_sessions: int
    attendance_percentage: Optional[float] = None
    total_present: int
    total_eligible: int

    model_config = ConfigDict(from_attributes=True)


class StudentAttentionItem(BaseModel):
    student_user_id: uuid.UUID
    institutional_id: str
    student_name: str
    attendance_percentage: Optional[float] = None
    attended_sessions: int
    total_eligible_sessions: int
    consecutive_absences: int
    classes_to_recover: int = 0
    classes_can_miss: int
    is_shortage: bool
    is_recoverable: bool = True
    face_registration_state: Optional[str] = "UNREGISTERED"

    model_config = ConfigDict(from_attributes=True)


class SectionAnalyticsResponse(BaseModel):
    teaching_assignment_id: uuid.UUID
    class_section_id: uuid.UUID
    section_code: str
    subject_id: uuid.UUID
    subject_code: str
    subject_name: str
    academic_term_id: uuid.UUID
    term_name: str
    faculty_name: str
    is_delegated: bool = False
    total_held_sessions: int
    total_cancelled_sessions: int
    total_exempt_sessions: int
    average_attendance_percentage: Optional[float] = None
    threshold: float
    shortage_count: int
    total_enrolled_students: int
    trend: List[WeeklyTrendPoint]
    students_needing_attention: List[StudentAttentionItem]
    roster_summaries: List[StudentAttentionItem]

    model_config = ConfigDict(from_attributes=True)


class SectionOverviewSummary(BaseModel):
    teaching_assignment_id: uuid.UUID
    class_section_id: uuid.UUID
    section_code: str
    subject_code: str
    subject_name: str
    faculty_name: str
    held_sessions: int
    average_attendance_percentage: Optional[float] = None
    shortage_count: int
    total_enrolled: int
    is_delegated: bool = False

    model_config = ConfigDict(from_attributes=True)


class AnalyticsOverviewResponse(BaseModel):
    role: str
    academic_term_id: Optional[uuid.UUID] = None
    threshold: float
    consecutive_absent_threshold: int
    total_sections: int
    total_held_sessions: int
    overall_attendance_percentage: Optional[float] = None
    total_students_at_risk: int
    sections: List[SectionOverviewSummary]
    students_needing_attention: List[StudentAttentionItem]
    weekly_trend: List[WeeklyTrendPoint]

    model_config = ConfigDict(from_attributes=True)
