from datetime import date
import pytest
from pydantic import ValidationError

from src.models.enrollment import EnrollmentStatus
from src.schemas.enrollment import StudentEnrollmentCreate


def test_enrollment_schema_date_validation():
    # Valid date range
    enr = StudentEnrollmentCreate(
        student_user_id="11111111-1111-1111-1111-111111111111",
        class_section_id="22222222-2222-2222-2222-222222222222",
        academic_term_id="33333333-3333-3333-3333-333333333333",
        effective_start_date=date(2026, 9, 1),
        effective_end_date=date(2026, 12, 15),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    assert enr.effective_start_date == date(2026, 9, 1)

    # Valid open-ended date range (null end date)
    enr_open = StudentEnrollmentCreate(
        student_user_id="11111111-1111-1111-1111-111111111111",
        class_section_id="22222222-2222-2222-2222-222222222222",
        academic_term_id="33333333-3333-3333-3333-333333333333",
        effective_start_date=date(2026, 9, 1),
        effective_end_date=None,
    )
    assert enr_open.effective_end_date is None

    # Invalid date range: start after end
    with pytest.raises(ValidationError) as exc_info:
        StudentEnrollmentCreate(
            student_user_id="11111111-1111-1111-1111-111111111111",
            class_section_id="22222222-2222-2222-2222-222222222222",
            academic_term_id="33333333-3333-3333-3333-333333333333",
            effective_start_date=date(2026, 10, 1),
            effective_end_date=date(2026, 9, 1),
        )
    assert "effective_end_date must be on or after effective_start_date" in str(exc_info.value)


def test_attendance_eligibility_formula_logic():
    """
    Test date-bounded eligibility formula:
    Sessions before effective_start_date MUST NOT be counted in numerator or denominator.
    """
    effective_start = date(2026, 9, 20)
    effective_end = None

    sessions = [
        {"date": date(2026, 9, 5), "attended": False},
        {"date": date(2026, 9, 10), "attended": False},
        {"date": date(2026, 9, 15), "attended": False},
        {"date": date(2026, 9, 22), "attended": True},
        {"date": date(2026, 9, 25), "attended": False},
    ]

    # Compute metric with date bounding
    eligible_sessions = [
        s for s in sessions
        if s["date"] >= effective_start and (effective_end is None or s["date"] <= effective_end)
    ]
    attended_count = sum(1 for s in eligible_sessions if s["attended"])
    total_eligible = len(eligible_sessions)

    # Verify: 3 sessions before Sept 20 are completely excluded!
    assert total_eligible == 2  # Only Sept 22 and Sept 25
    assert attended_count == 1
    assert round((attended_count / total_eligible) * 100, 1) == 50.0

    # Verify unearned absences are ZERO:
    unearned_absences = sum(1 for s in sessions if s["date"] < effective_start and not s["attended"])
    assert unearned_absences == 3
    # In student's record, eligible unearned absences counted is 0:
    counted_absences = sum(1 for s in eligible_sessions if not s["attended"])
    assert counted_absences == 1  # Only Sept 25
