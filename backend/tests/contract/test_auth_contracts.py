import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import get_password_hash
from src.models.enrollment import FaceRegistrationStatus, StudentFaceProfile
from src.models.user import AccountStatus, User, UserRole


@pytest.fixture
async def seeded_users(db_session: AsyncSession):
    """Seed test users across ADMIN, FACULTY, and STUDENT roles."""
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
    suspended_user = User(
        institutional_id="SUSPENDED-01",
        email="suspended_test@attendly.edu",
        password_hash=get_password_hash("password"),
        full_name="Suspended Faculty",
        role=UserRole.FACULTY,
        account_status=AccountStatus.SUSPENDED,
    )

    db_session.add_all([admin_user, faculty_user, student_user, suspended_user])
    await db_session.flush()

    # Add face profile for student_user
    face_profile = StudentFaceProfile(
        student_user_id=student_user.id,
        registration_state=FaceRegistrationStatus.REGISTERED,
        active_model_version="edgeface_xs_v1",
        sample_count=3,
        quality_score=0.95,
    )
    db_session.add(face_profile)
    await db_session.flush()

    return {
        "admin": admin_user,
        "faculty": faculty_user,
        "student": student_user,
        "suspended": suspended_user,
    }


@pytest.mark.asyncio
async def test_login_successful_faculty_by_institutional_id(async_client: AsyncClient, seeded_users):
    """Verify faculty can log in using institutional ID."""
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "prof_alan", "password": "password"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert data["expires_in"] > 0
    assert data["user"]["institutional_id"] == "prof_alan"
    assert data["user"]["role"] == "FACULTY"
    assert data["user"]["email"] == "prof_alan@attendly.edu"


@pytest.mark.asyncio
async def test_login_successful_faculty_by_email(async_client: AsyncClient, seeded_users):
    """Verify faculty can log in using email address."""
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "prof_alan@attendly.edu", "password": "password"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["user"]["institutional_id"] == "prof_alan"
    assert data["user"]["role"] == "FACULTY"


@pytest.mark.asyncio
async def test_login_successful_admin(async_client: AsyncClient, seeded_users):
    """Verify admin login returns ADMIN role."""
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "ADM-TEST-001", "password": "AdminPass123!"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["user"]["role"] == "ADMIN"
    assert data["user"]["institutional_id"] == "ADM-TEST-001"


@pytest.mark.asyncio
async def test_login_successful_student_with_face_registration(async_client: AsyncClient, seeded_users):
    """Verify student login reflects dynamic face registration state."""
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "S1", "password": "password"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["user"]["role"] == "STUDENT"
    assert data["user"]["face_registration_state"] == "REGISTERED"


@pytest.mark.asyncio
async def test_login_jwt_token_interoperability_with_me(async_client: AsyncClient, seeded_users):
    """Verify JWT issued by /login authenticates at GET /api/v1/auth/me."""
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
    assert me_data["id"] == str(seeded_users["faculty"].id)
    assert me_data["institutional_id"] == "prof_alan"
    assert me_data["role"] == "FACULTY"


@pytest.mark.asyncio
async def test_login_invalid_password(async_client: AsyncClient, seeded_users):
    """Verify invalid password returns 401 with standard error format."""
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "prof_alan", "password": "WrongPassword!"},
    )
    assert response.status_code == 401
    data = response.json()
    assert data["error"] == "AUTHENTICATION_FAILED"
    assert "Invalid username or password" in data["message"]


@pytest.mark.asyncio
async def test_login_nonexistent_user(async_client: AsyncClient, seeded_users):
    """Verify non-existent user returns 401 without leaking user existence."""
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "non_existent_user_999", "password": "password"},
    )
    assert response.status_code == 401
    data = response.json()
    assert data["error"] == "AUTHENTICATION_FAILED"
    assert "Invalid username or password" in data["message"]


@pytest.mark.asyncio
async def test_login_suspended_account(async_client: AsyncClient, seeded_users):
    """Verify suspended user cannot log in."""
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "SUSPENDED-01", "password": "password"},
    )
    assert response.status_code == 401
    data = response.json()
    assert data["error"] == "AUTHENTICATION_FAILED"
    assert "suspended" in data["message"].lower()


@pytest.mark.asyncio
async def test_login_malformed_request(async_client: AsyncClient):
    """Verify validation error on missing fields."""
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "only_username"},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_login_case_insensitivity(async_client: AsyncClient, seeded_users):
    """Verify login handles case differences gracefully."""
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "PROF_ALAN", "password": "password"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["institutional_id"] == "prof_alan"
