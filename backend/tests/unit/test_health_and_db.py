import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.user import User, UserRole, AccountStatus
from src.core.security import get_password_hash


@pytest.mark.asyncio
async def test_health_endpoint(async_client: AsyncClient):
    response = await async_client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"


@pytest.mark.asyncio
async def test_liveness_endpoint(async_client: AsyncClient):
    response = await async_client.get("/health/live")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "alive"


@pytest.mark.asyncio
async def test_readiness_endpoint(async_client: AsyncClient):
    response = await async_client.get("/health/ready")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"
    assert data["database"] == "connected"


@pytest.mark.asyncio
async def test_db_session_and_rollback(db_session: AsyncSession):
    # Insert a test user in this transaction
    user = User(
        institutional_id="TEST-USER-001",
        email="test001@institution.edu",
        password_hash=get_password_hash("password123"),
        full_name="Test User",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(user)
    await db_session.flush()

    assert user.id is not None

    # Query back
    stmt = select(User).where(User.institutional_id == "TEST-USER-001")
    result = await db_session.execute(stmt)
    retrieved = result.scalar_one_or_none()
    assert retrieved is not None
    assert retrieved.email == "test001@institution.edu"
    assert retrieved.role == UserRole.FACULTY
