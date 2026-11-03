from datetime import date, timedelta
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import TeachingAssignment
from src.models.user import AccountStatus, User, UserRole


@pytest.mark.asyncio
async def test_substitute_delegation_lifecycle(
    async_client: AsyncClient, db_session: AsyncSession
):
    """
    T041: Integration test for substitute delegation lifecycle.
    Proves:
    1. Immediate activation without administrative pre-approval (SC-004).
    2. Sub-delegation rejection (FR-014: substitute cannot sub-delegate).
    3. Automatic expiration on end_date (FR-013: access revoked when current_date > end_date).
    4. Early revocation by assigned faculty.
    """
    # 1. Setup Admin, Regular Faculty A, Colleague B, Colleague C
    admin = User(
        institutional_id="ADM-LIFECYCLE-01",
        email="admin_lifecycle@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Admin Lifecycle",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    fac_a = User(
        institutional_id="FAC-LIFECYCLE-A",
        email="fac_a_lifecycle@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Dr. Permanent Faculty A",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_b = User(
        institutional_id="FAC-LIFECYCLE-B",
        email="fac_b_lifecycle@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Prof. Substitute B",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_c = User(
        institutional_id="FAC-LIFECYCLE-C",
        email="fac_c_lifecycle@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Prof. Third Colleague C",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, fac_a, fac_b, fac_c])
    await db_session.flush()

    dept = Department(code="MECH", name="Mechanical Engineering")
    term = AcademicTerm(
        code="2026-FALL-MECH",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="ME201", name="Thermodynamics", department_id=dept.id, credits=3)
    section = ClassSection(
        section_code="MECH-2A",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2025,
    )
    db_session.add_all([subject, section])
    await db_session.flush()

    assignment = TeachingAssignment(
        faculty_user_id=fac_a.id,
        class_section_id=section.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add(assignment)
    await db_session.flush()

    token_a = create_access_token(
        subject=str(fac_a.id),
        role=fac_a.role.value,
        institutional_id=fac_a.institutional_id,
    )
    headers_a = {"Authorization": f"Bearer {token_a}"}

    token_b = create_access_token(
        subject=str(fac_b.id),
        role=fac_b.role.value,
        institutional_id=fac_b.institutional_id,
    )
    headers_b = {"Authorization": f"Bearer {token_b}"}

    # Step 1: Before delegation, Faculty B has NO access to this offering
    today = date(2026, 10, 5)
    unauthorized_res = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date={today.isoformat()}",
        headers=headers_b,
    )
    assert unauthorized_res.status_code == 403

    # Step 2: Faculty A delegates Oct 5 to Oct 7 to Faculty B
    start_date = date(2026, 10, 5)
    end_date = date(2026, 10, 7)
    create_res = await async_client.post(
        f"/api/v1/faculty/assignments/{assignment.id}/delegations",
        json={
            "substitute_faculty_user_id": str(fac_b.id),
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "delegation_reason": "Medical appointment and lab oversight",
        },
        headers=headers_a,
    )
    assert create_res.status_code == 201
    del_obj = create_res.json()
    delegation_id = del_obj["id"]

    # Step 3: Immediate activation: Faculty B can access roster on Oct 5 and Oct 7
    active_res = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date=2026-10-05",
        headers=headers_b,
    )
    assert active_res.status_code == 200

    active_res2 = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date=2026-10-07",
        headers=headers_b,
    )
    assert active_res2.status_code == 200

    # Step 4: Sub-delegation rejection: Faculty B tries to delegate to Faculty C
    sub_del_res = await async_client.post(
        f"/api/v1/faculty/assignments/{assignment.id}/delegations",
        json={
            "substitute_faculty_user_id": str(fac_c.id),
            "start_date": "2026-10-06",
            "end_date": "2026-10-06",
            "delegation_reason": "Pass delegation to colleague C",
        },
        headers=headers_b,
    )
    assert sub_del_res.status_code == 403

    # Step 5: Automatic expiration: On Oct 8 (current_date > end_date), access is forbidden
    expired_res = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date=2026-10-08",
        headers=headers_b,
    )
    assert expired_res.status_code == 403

    # Step 6: Early revocation: Faculty A revokes delegation early
    revoke_res = await async_client.post(
        f"/api/v1/faculty/delegations/{delegation_id}/revoke",
        json={"revocation_reason": "Returned early from clinic"},
        headers=headers_a,
    )
    assert revoke_res.status_code == 200
    assert revoke_res.json()["status"] == "REVOKED"

    # Step 7: After revocation, Oct 6 access is immediately revoked
    revoked_access_res = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date=2026-10-06",
        headers=headers_b,
    )
    assert revoked_access_res.status_code == 403
