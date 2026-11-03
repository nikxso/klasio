from datetime import date, timedelta
import uuid
import pytest
from pydantic import ValidationError

from src.models.enrollment import EnrollmentStatus
from src.schemas.enrollment import StudentTransferRequest, StudentTransferResponse, StudentEnrollmentResponse


def test_transfer_request_schema_validation():
    student_id = uuid.uuid4()
    new_sec_id = uuid.uuid4()
    cur_sec_id = uuid.uuid4()
    t_date = date(2026, 10, 20)

    req = StudentTransferRequest(
        student_user_id=student_id,
        new_class_section_id=new_sec_id,
        transfer_date=t_date,
        current_class_section_id=cur_sec_id,
    )
    assert req.student_user_id == student_id
    assert req.new_class_section_id == new_sec_id
    assert req.transfer_date == t_date
    assert req.current_class_section_id == cur_sec_id


def test_transfer_boundary_date_math():
    transfer_date = date(2026, 10, 20)
    previous_end_date = transfer_date - timedelta(days=1)
    new_start_date = transfer_date

    assert previous_end_date == date(2026, 10, 19)
    assert new_start_date == date(2026, 10, 20)
    assert previous_end_date < new_start_date


def test_transfer_interval_disjointness():
    """
    Verify mathematical interval disjointness:
    Interval 1: [2026-09-01, 2026-10-19]
    Interval 2: [2026-10-20, None]
    No single date can belong to both intervals.
    """
    start1 = date(2026, 9, 1)
    end1 = date(2026, 10, 19)
    start2 = date(2026, 10, 20)
    end2 = None

    # Date before transfer
    d_before = date(2026, 10, 15)
    in_int1 = start1 <= d_before <= end1
    in_int2 = start2 <= d_before and (end2 is None or d_before <= end2)
    assert in_int1 is True
    assert in_int2 is False

    # Date on transfer
    d_on = date(2026, 10, 20)
    in_int1 = start1 <= d_on <= end1
    in_int2 = start2 <= d_on and (end2 is None or d_on <= end2)
    assert in_int1 is False
    assert in_int2 is True

    # Date after transfer
    d_after = date(2026, 10, 25)
    in_int1 = start1 <= d_after <= end1
    in_int2 = start2 <= d_after and (end2 is None or d_after <= end2)
    assert in_int1 is False
    assert in_int2 is True
