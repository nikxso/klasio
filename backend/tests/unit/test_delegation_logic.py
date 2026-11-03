from datetime import date
import pytest
import uuid

from src.core.exceptions import OutOfScopeError
from src.schemas.assignment import CreateDelegationRequest, DelegationStatus


def test_delegation_request_schema_validation():
    """Unit test for CreateDelegationRequest date invariants and validation."""
    sub_id = uuid.uuid4()

    # Valid request
    req = CreateDelegationRequest(
        substitute_faculty_user_id=sub_id,
        start_date=date(2026, 10, 5),
        end_date=date(2026, 10, 7),
        delegation_reason="Conducted conference travel",
    )
    assert req.substitute_faculty_user_id == sub_id
    assert req.end_date >= req.start_date
    assert len(req.delegation_reason) >= 5

    # Invalid date range (end_date < start_date)
    with pytest.raises(ValueError, match="end_date must be on or after start_date"):
        CreateDelegationRequest(
            substitute_faculty_user_id=sub_id,
            start_date=date(2026, 10, 8),
            end_date=date(2026, 10, 5),
            delegation_reason="Invalid date order",
        )

    # Short reason (< 5 chars)
    with pytest.raises(ValueError):
        CreateDelegationRequest(
            substitute_faculty_user_id=sub_id,
            start_date=date(2026, 10, 5),
            end_date=date(2026, 10, 7),
            delegation_reason="sick",
        )
