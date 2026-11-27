from datetime import date
from typing import Optional
import uuid
from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import UnauthorizedRoleError
from src.core.permissions import require_faculty_or_admin
from src.database import get_db_session
from src.models.user import User, UserRole
from src.schemas.analytics import AnalyticsOverviewResponse, SectionAnalyticsResponse
from src.services.analytics_service import AnalyticsService, get_institution_threshold
from src.services.export_service import ExportService

router = APIRouter(prefix="/api/v1/analytics", tags=["Attendance Analytics & Intelligence"])


@router.get("/overview", response_model=AnalyticsOverviewResponse, summary="Retrieve attendance analytics overview")
async def get_analytics_overview(
    academic_term_id: Optional[uuid.UUID] = Query(None, description="Filter overview to an academic term"),
    threshold: Optional[float] = Query(None, ge=1.0, le=100.0, description="Configured shortage threshold percentage"),
    consecutive_absent_threshold: int = Query(2, ge=1, le=20, description="Consecutive absent alert threshold"),
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Retrieve aggregated attendance overview.
    - Admin: institutional summary across active teaching assignments.
    - Faculty: scoped strictly to assigned offerings, active substitute delegations, or departmental/section IAC scopes.
    - Students are strictly forbidden (use /api/v1/student/attendance).
    """
    inst_threshold = await get_institution_threshold(db)
    effective_threshold = threshold if threshold is not None else inst_threshold

    if current_user.role != UserRole.ADMIN:
        if effective_threshold != inst_threshold or consecutive_absent_threshold != 2:
            raise UnauthorizedRoleError("Only administrators can override institutional policy thresholds")

    service = AnalyticsService(db)
    return await service.get_overview(
        current_user=current_user,
        academic_term_id=academic_term_id,
        threshold=effective_threshold,
        consecutive_threshold=consecutive_absent_threshold,
    )


@router.get(
    "/assignments/{teaching_assignment_id}",
    response_model=SectionAnalyticsResponse,
    summary="Retrieve detailed section attendance analytics",
)
async def get_section_analytics(
    teaching_assignment_id: uuid.UUID,
    threshold: Optional[float] = Query(None, ge=1.0, le=100.0, description="Configured shortage threshold percentage"),
    consecutive_absent_threshold: int = Query(2, ge=1, le=20, description="Consecutive absent alert threshold"),
    start_date: Optional[date] = Query(None, description="Optional start date filter"),
    end_date: Optional[date] = Query(None, description="Optional end date filter"),
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Retrieve section attendance analytics, weekly trends, and students needing attention.
    Scoped to assigned faculty, valid substitute faculty, or Admin.
    Students are strictly forbidden.
    """
    inst_threshold = await get_institution_threshold(db)
    effective_threshold = threshold if threshold is not None else inst_threshold

    if current_user.role != UserRole.ADMIN:
        if effective_threshold != inst_threshold or consecutive_absent_threshold != 2:
            raise UnauthorizedRoleError("Only administrators can override institutional policy thresholds")
    service = AnalyticsService(db)
    return await service.get_assignment_analytics(
        current_user=current_user,
        teaching_assignment_id=teaching_assignment_id,
        threshold=effective_threshold,
        consecutive_threshold=consecutive_absent_threshold,
        start_date=start_date,
        end_date=end_date,
    )


@router.get(
    "/assignments/{teaching_assignment_id}/export",
    summary="Export section attendance report to CSV",
    responses={
        200: {
            "content": {"text/csv": {"schema": {"type": "string"}}},
            "description": "Section attendance report in CSV format",
        }
    },
)
async def export_section_attendance_csv(
    teaching_assignment_id: uuid.UUID,
    report_type: str = Query("roster", pattern="^(roster|sessions)$", description="Type of report: 'roster' or 'sessions'"),
    threshold: float = Query(75.0, ge=1.0, le=100.0, description="Configured shortage threshold percentage"),
    start_date: Optional[date] = Query(None, description="Optional start date filter"),
    end_date: Optional[date] = Query(None, description="Optional end date filter"),
    shortage_only: bool = Query(False, description="Filter roster export to students below threshold"),
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Export finalized section attendance data to sanitized CSV.
    - report_type='roster': student summary, held/attended counts, percentages, shortage indicators.
    - report_type='sessions': chronological attendance marks per student per session.
    - Scoped strictly to assigned faculty, valid substitute, or Admin.
    - Students are strictly forbidden.
    """
    if current_user.role != UserRole.ADMIN and threshold != 75.0:
        raise UnauthorizedRoleError("Only administrators can override institutional policy thresholds")

    export_service = ExportService(db)
    if report_type == "sessions":
        filename, streamer = await export_service.generate_assignment_sessions_csv(
            current_user=current_user,
            teaching_assignment_id=teaching_assignment_id,
            start_date=start_date,
            end_date=end_date,
        )
    else:
        filename, streamer = await export_service.generate_assignment_roster_csv(
            current_user=current_user,
            teaching_assignment_id=teaching_assignment_id,
            start_date=start_date,
            end_date=end_date,
            shortage_only=shortage_only,
            threshold=threshold,
        )

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Type": "text/csv; charset=utf-8",
    }
    return StreamingResponse(streamer, media_type="text/csv", headers=headers)


@router.get(
    "/overview/export",
    summary="Export institutional or faculty attendance overview to CSV",
    responses={
        200: {
            "content": {"text/csv": {"schema": {"type": "string"}}},
            "description": "Attendance overview report in CSV format",
        }
    },
)
async def export_overview_csv(
    academic_term_id: Optional[uuid.UUID] = Query(None, description="Filter overview to an academic term"),
    threshold: float = Query(75.0, ge=1.0, le=100.0, description="Configured shortage threshold percentage"),
    start_date: Optional[date] = Query(None, description="Optional start date filter"),
    end_date: Optional[date] = Query(None, description="Optional end date filter"),
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Export aggregated attendance overview to CSV.
    - Admin: institutional overview across all sections.
    - Faculty: scoped strictly to assigned and actively delegated offerings.
    - Students are strictly forbidden.
    """
    if current_user.role != UserRole.ADMIN and threshold != 75.0:
        raise UnauthorizedRoleError("Only administrators can override institutional policy thresholds")

    export_service = ExportService(db)
    filename, streamer = await export_service.generate_overview_csv(
        current_user=current_user,
        academic_term_id=academic_term_id,
        threshold=threshold,
        start_date=start_date,
        end_date=end_date,
    )

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Type": "text/csv; charset=utf-8",
    }
    return StreamingResponse(streamer, media_type="text/csv", headers=headers)
