import pytest
from httpx import AsyncClient
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.permissions import require_admin, require_faculty, require_student
from src.core.security import create_access_token, get_password_hash
from src.main import app
from src.models.user import AccountStatus, User, UserRole

# Register test routes on a router
auth_test_router = APIRouter(prefix="/test-auth", tags=["Testing Auth"])


@auth_test_router.get("/admin-only")
async def admin_only_endpoint(user: User = Depends(require_admin)):
    return {"message": "hello admin", "user_id": str(user.id)}


@auth_test_router.get("/faculty-only")
async def faculty_only_endpoint(user: User = Depends(require_faculty)):
    return {"message": "hello faculty", "user_id": str(user.id)}


@auth_test_router.get("/student-only")
async def student_only_endpoint(user: User = Depends(require_student)):
    return {"message": "hello student", "user_id": str(user.id)}


# Include the test router into app
app.include_router(auth_test_router)


@pytest.mark.asyncio
async def test_permissions_unauthenticated(async_client: AsyncClient):
    response = await async_client.get("/test-auth/admin-only")
    assert response.status_code == 401
    assert response.json()["error"] == "AUTHENTICATION_FAILED"


@pytest.mark.asyncio
async def test_permissions_role_authorized(async_client: AsyncClient, db_session: AsyncSession):
    # Create faculty user
    faculty = User(
        institutional_id="FAC-PERM-01",
        email="faculty_perm@institution.edu",
        password_hash=get_password_hash("password123"),
        full_name="Prof Perm",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(faculty)
    await db_session.flush()

    token = create_access_token(
        subject=str(faculty.id),
        role=faculty.role.value,
        institutional_id=faculty.institutional_id,
    )

    headers = {"Authorization": f"Bearer {token}"}

    # Faculty can access faculty-only
    response = await async_client.get("/test-auth/faculty-only", headers=headers)
    assert response.status_code == 200
    assert response.json()["message"] == "hello faculty"


@pytest.mark.asyncio
async def test_permissions_cross_role_forbidden(async_client: AsyncClient, db_session: AsyncSession):
    # Create student user
    student = User(
        institutional_id="STU-PERM-01",
        email="student_perm@institution.edu",
        password_hash=get_password_hash("password123"),
        full_name="Student Perm",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(student)
    await db_session.flush()

    token = create_access_token(
        subject=str(student.id),
        role=student.role.value,
        institutional_id=student.institutional_id,
    )

    headers = {"Authorization": f"Bearer {token}"}

    # Student accessing admin-only should receive 403 Forbidden
    response = await async_client.get("/test-auth/admin-only", headers=headers)
    assert response.status_code == 403
    assert response.json()["error"] == "INSUFFICIENT_ROLE"

    # Student accessing faculty-only should receive 403 Forbidden
    response = await async_client.get("/test-auth/faculty-only", headers=headers)
    assert response.status_code == 403
    assert response.json()["error"] == "INSUFFICIENT_ROLE"

    # Student accessing student-only should succeed
    response = await async_client.get("/test-auth/student-only", headers=headers)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_permissions_suspended_user(async_client: AsyncClient, db_session: AsyncSession):
    suspended_user = User(
        institutional_id="SUSP-01",
        email="suspended@institution.edu",
        password_hash=get_password_hash("password123"),
        full_name="Suspended User",
        role=UserRole.FACULTY,
        account_status=AccountStatus.SUSPENDED,
    )
    db_session.add(suspended_user)
    await db_session.flush()

    token = create_access_token(
        subject=str(suspended_user.id),
        role=suspended_user.role.value,
        institutional_id=suspended_user.institutional_id,
    )

    headers = {"Authorization": f"Bearer {token}"}
    response = await async_client.get("/test-auth/faculty-only", headers=headers)
    assert response.status_code == 401
    assert "SUSPENDED" in response.json()["message"]
