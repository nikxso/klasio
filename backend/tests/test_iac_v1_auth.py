import pytest
import pytest_asyncio
import uuid
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import get_password_hash
from src.main import app
from src.models.access_control import (
    AssignmentStatus,
    DEFAULT_INSTITUTION_ID,
    InstitutionMembership,
    MembershipStatus,
    RoleAssignment,
    RoleAssignmentScope,
    RoleScopeType,
    RoleTemplate,
)
from src.models.academic import Department
from src.models.user import AccountStatus, User, UserRole


@pytest_asyncio.fixture(autouse=True)
async def seed_iac_users(db_session: AsyncSession):
    """Seed test users across ADMIN, FACULTY, and STUDENT roles for IAC v1 auth tests."""
    admin_user = User(
        institutional_id="ADM-TEST-001",
        email="admin_test@institution.edu",
        password_hash=get_password_hash("AdminPass123!"),
        full_name="Dr. Admin Meera",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_user = User(
        institutional_id="prof_alan",
        email="prof_alan@attendly.edu",
        password_hash=get_password_hash("password"),
        full_name="Prof. Alan Turing",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student_user = User(
        institutional_id="S1",
        email="student_s1@attendly.edu",
        password_hash=get_password_hash("password"),
        full_name="Student S1",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )

    db_session.add_all([admin_user, faculty_user, student_user])
    await db_session.flush()

    return {
        "admin": admin_user,
        "faculty": faculty_user,
        "student": student_user,
    }


@pytest.mark.asyncio
async def test_login_returns_iac_v1_context(async_client: AsyncClient):
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "prof_alan", "password": "password"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    user = data["user"]
    assert user["institutional_id"] == "prof_alan"
    assert user["role"] == "FACULTY"  # backward-compatible projection
    assert "institution_id" in user
    assert user["institution_id"] is not None
    assert "role_assignments" in user
    assert isinstance(user["role_assignments"], list)
    assert len(user["role_assignments"]) > 0
    assert user["role_assignments"][0]["role_template_code"] == "FACULTY"
    assert user["role_assignments"][0]["scope_type"] == "INSTITUTION"
    assert "permissions" in user
    assert isinstance(user["permissions"], list)
    # prof_alan has attendance conduct permissions
    assert "attendance.session.start" in user["permissions"] or "attendance:scan" in user["permissions"]


@pytest.mark.asyncio
async def test_me_returns_iac_v1_context(async_client: AsyncClient):
    login_resp = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "prof_alan", "password": "password"},
    )
    assert login_resp.status_code == 200
    token = login_resp.json()["access_token"]

    me_resp = await async_client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me_resp.status_code == 200
    me_data = me_resp.json()
    assert me_data["institutional_id"] == "prof_alan"
    assert me_data["role"] == "FACULTY"
    assert "institution_id" in me_data
    assert me_data["institution_id"] is not None
    assert "role_assignments" in me_data
    assert isinstance(me_data["role_assignments"], list)
    assert len(me_data["role_assignments"]) > 0
    assert "permissions" in me_data
    assert isinstance(me_data["permissions"], list)
    assert "attendance.session.start" in me_data["permissions"]


@pytest.mark.asyncio
async def test_department_scoped_role_assignment_serialization(
    async_client: AsyncClient,
    db_session: AsyncSession,
):
    # Create department
    inst_uuid = uuid.UUID(DEFAULT_INSTITUTION_ID)
    dept = Department(
        institution_id=inst_uuid,
        code="CS-TEST",
        name="Computer Science & Engineering",
    )
    db_session.add(dept)
    await db_session.flush()

    # Create special faculty user
    dept_faculty = User(
        institutional_id="prof_turing_dept",
        email="turing_dept@attendly.edu",
        password_hash=get_password_hash("password"),
        full_name="Prof. Alan Turing Dept",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(dept_faculty)
    await db_session.flush()

    # Create membership
    membership = InstitutionMembership(
        institution_id=inst_uuid,
        user_id=dept_faculty.id,
        status=MembershipStatus.ACTIVE,
    )
    db_session.add(membership)
    await db_session.flush()

    # Find FACULTY role template
    res = await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))
    faculty_tpl = res.scalar_one()

    # Assign role with DEPARTMENT scope
    assignment = RoleAssignment(
        institution_id=inst_uuid,
        membership_id=membership.id,
        role_template_id=faculty_tpl.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(assignment)
    await db_session.flush()

    scope = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=inst_uuid,
        scope_type=RoleScopeType.DEPARTMENT,
        department_id=dept.id,
    )
    db_session.add(scope)
    await db_session.flush()

    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "prof_turing_dept", "password": "password"},
    )
    assert response.status_code == 200
    user_data = response.json()["user"]
    assert user_data["role_assignments"][0]["scope_type"] == "DEPARTMENT"
    assert user_data["role_assignments"][0]["department_code"] == "CS-TEST"


@pytest.mark.asyncio
async def test_login_admin_legacy_mapping(async_client: AsyncClient):
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "ADM-TEST-001", "password": "AdminPass123!"},
    )
    assert response.status_code == 200
    data = response.json()
    user = data["user"]
    assert user["role"] == "ADMIN"
    assert len(user["role_assignments"]) > 0
    assert user["role_assignments"][0]["role_template_code"] == "CENTRAL_INSTITUTION_ADMIN"
    assert "institution.manage" in user["permissions"]


@pytest.mark.asyncio
async def test_login_student_legacy_mapping(async_client: AsyncClient):
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "S1", "password": "password"},
    )
    assert response.status_code == 200
    data = response.json()
    user = data["user"]
    assert user["role"] == "STUDENT"
    assert len(user["role_assignments"]) > 0
    assert user["role_assignments"][0]["role_template_code"] == "STUDENT"
    assert "biometrics.enroll.self" in user["permissions"]
    assert "attendance.session.start" not in user["permissions"]


@pytest.mark.asyncio
async def test_inactive_role_assignments_excluded(
    async_client: AsyncClient,
    db_session: AsyncSession,
):
    inst_uuid = uuid.UUID(DEFAULT_INSTITUTION_ID)
    user = User(
        institutional_id="revoked_faculty_user",
        email="revoked_faculty@attendly.edu",
        password_hash=get_password_hash("password"),
        full_name="Revoked Faculty User",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(user)
    await db_session.flush()

    membership = InstitutionMembership(
        institution_id=inst_uuid,
        user_id=user.id,
        status=MembershipStatus.ACTIVE,
    )
    db_session.add(membership)
    await db_session.flush()

    res_fac = await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "FACULTY"))
    faculty_tpl = res_fac.scalar_one()

    res_stu = await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "STUDENT"))
    student_tpl = res_stu.scalar_one()

    # Add active STUDENT assignment
    active_assignment = RoleAssignment(
        institution_id=inst_uuid,
        membership_id=membership.id,
        role_template_id=student_tpl.id,
        status=AssignmentStatus.ACTIVE,
    )
    db_session.add(active_assignment)

    # Add REVOKED FACULTY assignment
    revoked_assignment = RoleAssignment(
        institution_id=inst_uuid,
        membership_id=membership.id,
        role_template_id=faculty_tpl.id,
        status=AssignmentStatus.REVOKED,
    )
    db_session.add(revoked_assignment)
    await db_session.flush()

    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "revoked_faculty_user", "password": "password"},
    )
    assert response.status_code == 200
    user_data = response.json()["user"]
    # The active student assignment must be present
    assert any(ra["role_template_code"] == "STUDENT" for ra in user_data["role_assignments"])
    # The revoked faculty assignment must NOT be in active role_assignments
    assert not any(ra["role_template_code"] == "FACULTY" for ra in user_data["role_assignments"])
    # Faculty permissions must not be granted
    assert "attendance.session.start" not in user_data["permissions"]
