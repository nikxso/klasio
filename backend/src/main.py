from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from src.config import get_settings
from src.database import async_session_factory
from src.core.exceptions import register_exception_handlers
from src.api.v1.auth import router as auth_router
from src.api.v1.admin import router as admin_router
from src.api.v1.faculty import router as faculty_router
from src.api.v1.student import router as student_router
from src.api.v1.attendance import router as attendance_router
from src.api.v1.analytics import router as analytics_router
from src.api.v1.biometrics import router as biometrics_router
from src.api.v1.notifications import router as notifications_router
from src.api.v1.users import router as users_router

settings = get_settings()


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.APP_NAME,
        version="0.1.0",
        description="Automated Student Attendance API",
        debug=settings.DEBUG,
    )

    cors_origins = (
        settings.CORS_ORIGINS
        if isinstance(settings.CORS_ORIGINS, list)
        else [settings.CORS_ORIGINS]
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    # Include API Routers
    app.include_router(auth_router)
    app.include_router(admin_router)
    app.include_router(faculty_router)
    app.include_router(student_router)
    app.include_router(attendance_router)
    app.include_router(analytics_router)
    app.include_router(biometrics_router)
    app.include_router(notifications_router)
    app.include_router(users_router)

    @app.get("/health", tags=["Health"])
    async def health_check():
        return {"status": "healthy", "app": settings.APP_NAME}

    @app.get("/health/live", tags=["Health"])
    async def liveness_check():
        return {"status": "alive"}

    @app.get("/health/ready", tags=["Health"])
    async def readiness_check(response: Response):
        try:
            async with async_session_factory() as session:
                await session.execute(text("SELECT 1"))
            return {"status": "ready", "database": "connected"}
        except Exception as e:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            return {"status": "unready", "database": "disconnected", "error": "Database unreachable"}

    return app


app = create_app()
