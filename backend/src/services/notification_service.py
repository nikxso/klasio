from datetime import datetime, timezone
from typing import List, Optional
import uuid
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.academic import DEFAULT_INSTITUTION_ID
from src.models.notification import Notification, NotificationCategory, NotificationPriority
from src.schemas.notification import NotificationResponse, NotificationUnreadCountResponse


class NotificationService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_user_notifications(
        self,
        user_id: uuid.UUID,
        unread_only: bool = False,
        category: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Notification]:
        query = select(Notification).where(Notification.user_id == user_id)
        if unread_only:
            query = query.where(Notification.is_read.is_(False))
        if category:
            query = query.where(Notification.category == category)
        query = query.order_by(Notification.created_at.desc()).limit(limit).offset(offset)
        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def get_unread_count(self, user_id: uuid.UUID) -> int:
        query = select(func.count(Notification.id)).where(
            Notification.user_id == user_id,
            Notification.is_read.is_(False),
        )
        result = await self.db.execute(query)
        return int(result.scalar_one() or 0)

    async def mark_as_read(self, user_id: uuid.UUID, notification_id: uuid.UUID) -> Optional[Notification]:
        stmt = (
            update(Notification)
            .where(
                Notification.id == notification_id,
                Notification.user_id == user_id,
            )
            .values(
                is_read=True,
                read_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
            .returning(Notification)
        )
        res = await self.db.execute(stmt)
        await self.db.commit()
        return res.scalar_one_or_none()

    async def mark_all_as_read(self, user_id: uuid.UUID) -> int:
        stmt = (
            update(Notification)
            .where(
                Notification.user_id == user_id,
                Notification.is_read.is_(False),
            )
            .values(
                is_read=True,
                read_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
        )
        res = await self.db.execute(stmt)
        await self.db.commit()
        return res.rowcount

    async def create_notification(
        self,
        user_id: uuid.UUID,
        title: str,
        message: str,
        category: str = NotificationCategory.ATTENDANCE.value,
        priority: str = NotificationPriority.NORMAL.value,
        link_type: Optional[str] = None,
        link_id: Optional[str] = None,
        deduplication_key: Optional[str] = None,
        institution_id: uuid.UUID = DEFAULT_INSTITUTION_ID,
    ) -> Optional[Notification]:
        if deduplication_key:
            # Check if notification with this dedup key already exists for this user
            existing = await self.db.execute(
                select(Notification).where(
                    Notification.user_id == user_id,
                    Notification.deduplication_key == deduplication_key,
                )
            )
            if existing.scalar_one_or_none():
                return None

        notif = Notification(
            institution_id=institution_id,
            user_id=user_id,
            title=title,
            message=message,
            category=category,
            priority=priority,
            link_type=link_type,
            link_id=link_id,
            deduplication_key=deduplication_key,
        )
        self.db.add(notif)
        await self.db.commit()
        await self.db.refresh(notif)
        return notif
