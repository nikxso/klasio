import enum
import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base, TimestampMixin
from src.models.academic import DEFAULT_INSTITUTION_ID


class NotificationCategory(str, enum.Enum):
    ATTENDANCE = "ATTENDANCE"
    SHORTAGE = "SHORTAGE"
    DELEGATION = "DELEGATION"
    REQUEST = "REQUEST"
    SYSTEM = "SYSTEM"


class NotificationPriority(str, enum.Enum):
    LOW = "LOW"
    NORMAL = "NORMAL"
    HIGH = "HIGH"
    URGENT = "URGENT"


class Notification(Base, TimestampMixin):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_user_unread", "user_id", "is_read", "created_at"),
        UniqueConstraint("user_id", "deduplication_key", name="uq_notifications_user_dedup"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("institutions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        default=DEFAULT_INSTITUTION_ID,
        server_default=text("'00000000-0000-0000-0000-000000000001'"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )
    message: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )
    category: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        default=NotificationCategory.ATTENDANCE.value,
    )
    priority: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=NotificationPriority.NORMAL.value,
    )
    link_type: Mapped[Optional[str]] = mapped_column(
        String(50),
        nullable=True,
    )
    link_id: Mapped[Optional[str]] = mapped_column(
        String(255),
        nullable=True,
    )
    is_read: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
        index=True,
    )
    read_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    deduplication_key: Mapped[Optional[str]] = mapped_column(
        String(128),
        nullable=True,
    )

    user = relationship("User", foreign_keys=[user_id])
