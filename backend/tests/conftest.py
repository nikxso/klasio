import asyncio
import os
from typing import AsyncGenerator
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from src.config import get_settings
from src.database import get_db_session
from src.main import app
from src.models.base import Base

# Ensure all models are imported so metadata is populated
import src.models  # noqa: F401

settings = get_settings()

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", settings.DATABASE_URL.replace("/atten_db", "/atten_test_db"))


@pytest.fixture(scope="session")
def event_loop():
    """Create a session-scoped event loop for pytest-asyncio."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def test_engine():
    """Create a persistent test database engine."""
    engine = create_async_engine(
        TEST_DATABASE_URL,
        poolclass=NullPool,
        echo=False,
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(
            text("""
                INSERT INTO institutions (id, code, name, status, created_at, updated_at)
                VALUES ('00000000-0000-0000-0000-000000000001', 'KLASIO_MAIN', 'Klasio Institute of Technology', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO NOTHING
            """)
        )
        await conn.execute(
            text("""
                INSERT INTO campuses (id, institution_id, code, name, status, created_at, updated_at)
                VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'MAIN', 'Main Campus', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO NOTHING
            """)
        )
        await conn.execute(
            text("""
                INSERT INTO deployment_config (singleton_id, institution_id, deployment_mode, attendance_shortage_threshold, created_at, updated_at)
                VALUES (1, '00000000-0000-0000-0000-000000000001', 'SINGLE_INSTITUTION_SELF_HOSTED', 75.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT (singleton_id) DO NOTHING
            """)
        )
        await conn.execute(
            text("""
                INSERT INTO academic_periods (id, institution_id, period_number, name, start_time, end_time, is_break, is_active, created_at, updated_at)
                VALUES
                    ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 1, 'Period 1', '09:00:00', '10:00:00', false, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                    ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 2, 'Period 2', '10:00:00', '11:00:00', false, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                    ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 3, 'Period 3', '11:00:00', '12:00:00', false, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT (institution_id, period_number) DO NOTHING;
            """)
        )
        if "postgres" in engine.url.drivername:
            await conn.execute(
                text("""
                    CREATE OR REPLACE FUNCTION trg_auto_create_institution_membership()
                    RETURNS TRIGGER AS $$
                    DECLARE
                        inst_id uuid;
                    BEGIN
                        SELECT institution_id INTO inst_id FROM deployment_config WHERE singleton_id = 1;
                        IF inst_id IS NOT NULL THEN
                            INSERT INTO institution_memberships (id, institution_id, user_id, status, joined_at, created_at, updated_at)
                            VALUES (gen_random_uuid(), inst_id, NEW.id, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                            ON CONFLICT (institution_id, user_id) DO NOTHING;
                        END IF;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;
                """)
            )
            await conn.execute(text("DROP TRIGGER IF EXISTS trg_user_auto_membership ON users;"))
            await conn.execute(
                text("""
                    CREATE TRIGGER trg_user_auto_membership
                    AFTER INSERT ON users
                    FOR EACH ROW
                    EXECUTE FUNCTION trg_auto_create_institution_membership();
                """)
            )
        else:
            await conn.execute(
                text("""
                    CREATE TRIGGER IF NOT EXISTS trg_user_auto_membership
                    AFTER INSERT ON users
                    FOR EACH ROW
                    BEGIN
                        INSERT OR IGNORE INTO institution_memberships (id, institution_id, user_id, status, joined_at, created_at, updated_at)
                        VALUES (lower(hex(randomblob(16))), '00000000-0000-0000-0000-000000000001', NEW.id, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
                    END;
                """)
            )

    session_factory = async_sessionmaker(
        bind=engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    async with session_factory() as session:
        from scripts.seed_access_control import seed_access_control_catalog
        await seed_access_control_catalog(session)

    yield engine

    await engine.dispose()


@pytest_asyncio.fixture(scope="function")
async def db_session(test_engine) -> AsyncGenerator[AsyncSession, None]:
    """Provide a transactional database session rolled back after every test."""
    async with test_engine.connect() as connection:
        transaction = await connection.begin()
        session_factory = async_sessionmaker(
            bind=connection,
            class_=AsyncSession,
            expire_on_commit=False,
        )
        async with session_factory() as session:
            yield session
            if transaction.is_active:
                await transaction.rollback()


@pytest_asyncio.fixture(scope="function")
async def async_client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """Provide an HTTP async test client with overridden database session."""
    async def override_get_db_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_db_session] = override_get_db_session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client

    app.dependency_overrides.clear()
