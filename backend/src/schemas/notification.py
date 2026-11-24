from datetime import datetime
import uuid
from typing import Optional
from pydantic import BaseModel, ConfigDict


class NotificationResponse(BaseModel):
    id: uuid.UUID
    institution_id: uuid.UUID
    user_id: uuid.UUID
    title: str
    message: str
    category: str
    priority: str
    link_type: Optional[str] = None
    link_id: Optional[str] = None
    payload_json: Optional[str] = None
    action_route: Optional[str] = None
    is_read: bool
    read_at: Optional[datetime] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class NotificationUnreadCountResponse(BaseModel):
    unread_count: int


class MarkNotificationReadRequest(BaseModel):
    notification_id: uuid.UUID
