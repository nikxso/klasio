from datetime import date
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.academic import AcademicTerm, ClassSection, Department, Subject
from src.models.assignment import TeachingAssignment
from src.models.enrollment import FaceRegistrationStatus, StudentEnrollment, StudentFaceProfile
from src.models.user import AccountStatus, User, UserRole

# Import the seed function from backend.scripts.seed_catalog
from scripts.seed_catalog import seed_development_catalog


@pytest.mark.asyncio
async def test_seed_catalog_creates_expected_entities(db_session: AsyncSession):
    """Verify first-time execution seeds all academic, role, and enrollment entities."""
    summary = await seed_development_catalog(db_session, default_password="password")

    assert (summary["created"]["terms"] + summary["reused"]["terms"]) >= 1
    assert (summary["created"]["departments"] + summary["reused"]["departments"]) >= 1
    assert (summary["created"]["subjects"] + summary["reused"]["subjects"]) >= 1
    assert (summary["created"]["sections"] + summary["reused"]["sections"]) >= 2
    assert (summary["created"]["users"] + summary["reused"]["users"]) >= 4
    assert (summary["created"]["assignments"] + summary["reused"]["assignments"]) >= 2
    assert (summary["created"]["enrollments"] + summary["reused"]["enrollments"]) >= 3

    # Check term
    term_stmt = select(AcademicTerm).where(AcademicTerm.code == "2026-FALL-SEM5")
    term = (await db_session.execute(term_stmt)).scalar_one_or_none()
    assert term is not None
    assert term.start_date == date(2026, 9, 1)

    # Check faculty Alan
    alan_stmt = select(User).where(User.institutional_id == "prof_alan")
    alan = (await db_session.execute(alan_stmt)).scalar_one_or_none()
    assert alan is not None
    assert alan.role == UserRole.FACULTY

    # Check student S2 late admission date
    s2_stmt = select(User).where(User.institutional_id == "S2")
    s2 = (await db_session.execute(s2_stmt)).scalar_one_or_none()
    assert s2 is not None

    enr_stmt = select(StudentEnrollment).where(StudentEnrollment.student_user_id == s2.id)
    s2_enr = (await db_session.execute(enr_stmt)).scalar_one_or_none()
    assert s2_enr is not None
    assert s2_enr.effective_start_date == date(2026, 9, 20)

    # Check student S3 face profile is UNREGISTERED
    s3_stmt = select(User).where(User.institutional_id == "S3")
    s3 = (await db_session.execute(s3_stmt)).scalar_one_or_none()
    assert s3 is not None

    fp_stmt = select(StudentFaceProfile).where(StudentFaceProfile.student_user_id == s3.id)
    s3_fp = (await db_session.execute(fp_stmt)).scalar_one_or_none()
    assert s3_fp is not None
    assert s3_fp.registration_state == FaceRegistrationStatus.UNREGISTERED


@pytest.mark.asyncio
async def test_seed_catalog_idempotency_without_duplication(db_session: AsyncSession):
    """Verify repeated execution reuses existing records without duplication or errors."""
    summary1 = await seed_development_catalog(db_session, default_password="password")
    assert (summary1["created"]["users"] + summary1["reused"]["users"]) > 0

    # Second run must report records as reused and 0 newly created
    summary2 = await seed_development_catalog(db_session, default_password="password")
    assert summary2["created"]["terms"] == 0
    assert summary2["created"]["departments"] == 0
    assert summary2["created"]["subjects"] == 0
    assert summary2["created"]["sections"] == 0
    assert summary2["created"]["users"] == 0
    assert summary2["created"]["assignments"] == 0
    assert summary2["created"]["enrollments"] == 0

    assert summary2["reused"]["terms"] >= 1
    assert summary2["reused"]["users"] >= 4


@pytest.mark.asyncio
async def test_seeded_users_can_authenticate_and_access_scoped_apis(
    async_client: AsyncClient,
    db_session: AsyncSession,
):
    """Verify seeded accounts authenticate via POST /api/v1/auth/login and access scoped APIs."""
    await seed_development_catalog(db_session, default_password="password")

    # 1. Admin login
    admin_login = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "admin_meera", "password": "password"},
    )
    assert admin_login.status_code == 200
    assert admin_login.json()["user"]["role"] == "ADMIN"

    # 2. Prof Alan login
    alan_login = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "prof_alan", "password": "password"},
    )
    assert alan_login.status_code == 200
    alan_token = alan_login.json()["access_token"]
    alan_headers = {"Authorization": f"Bearer {alan_token}"}

    # Prof Alan gets his assignments
    assign_resp = await async_client.get("/api/v1/faculty/assignments", headers=alan_headers)
    assert assign_resp.status_code == 200
    assignments = assign_resp.json()
    assert len(assignments) >= 1
    ta_3a = next(a for a in assignments if a["section_code"] == "CSE-3A")
    ta_3a_id = ta_3a["teaching_assignment_id"]

    # Prof Alan retrieves roster on 2026-09-23 (S1, S2, S3 all active)
    roster_resp = await async_client.get(
        f"/api/v1/faculty/assignments/{ta_3a_id}/roster?session_date=2026-09-23",
        headers=alan_headers,
    )
    assert roster_resp.status_code == 200
    roster_students = roster_resp.json()["eligible_students"]
    student_ids = [s["institutional_id"] for s in roster_students]
    assert "S1" in student_ids
    assert "S2" in student_ids
    assert "S3" in student_ids

    # On 2026-09-10, S2 should NOT appear (enrolled 2026-09-20)
    roster_early = await async_client.get(
        f"/api/v1/faculty/assignments/{ta_3a_id}/roster?session_date=2026-09-10",
        headers=alan_headers,
    )
    assert roster_early.status_code == 200
    early_ids = [s["institutional_id"] for s in roster_early.json()["eligible_students"]]
    assert "S1" in early_ids
    assert "S2" not in early_ids
    assert "S3" in early_ids
