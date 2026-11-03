from typing import List, Optional
import uuid
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.permissions import get_current_user
from src.database import get_db_session
from src.models.user import User
from src.schemas.notification import NotificationResponse, NotificationUnreadCountResponse
from src.services.notification_service import NotificationService

router = APIRouter(prefix="/api/v1/notifications", tags=["In-App Notifications"])


@router.get("", response_model=List[NotificationResponse], summary="List user's notifications")
async def list_notifications(
    unread_only: bool = Query(False, description="Filter to unread notifications only"),
    category: Optional[str] = Query(None, description="Optional category filter"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    service = NotificationService(db)
    return await service.list_user_notifications(
        user_id=current_user.id,
        unread_only=unread_only,
        category=category,
        limit=limit,
        offset=offset,
    )


@router.get("/unread-count", response_model=NotificationUnreadCountResponse, summary="Get unread notification count")
async def get_unread_count(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    service = NotificationService(db)
    count = await service.get_unread_count(current_user.id)
    return NotificationUnreadCountResponse(unread_count=count)


@router.post("/{notification_id}/read", response_model=Optional[NotificationResponse], summary="Mark notification as read")
async def mark_notification_as_read(
    notification_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    service = NotificationService(db)
    return await service.mark_as_read(current_user.id, notification_id)


@router.post("/mark-all-read", summary="Mark all notifications as read")
async def mark_all_notifications_as_read(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    service = NotificationService(db)
    count = await service.mark_all_as_read(current_user.id)
    return {"marked_read_count": count}
