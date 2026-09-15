# schemas/notification_schema.py
from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, ConfigDict


class WSEventType(str, Enum):
    LOW_TOKEN_WARNING = "LOW_TOKEN_WARNING"
    CALL_TERMINATED = "CALL_TERMINATED"


class NotificationResponse(BaseModel):
    id: int
    user_id: int
    message: str
    notification_type: str  # e.g., "LOW_TOKENS", "CALL_AUTO_TERMINATED"
    is_read: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WSEventPayload(BaseModel):
    event: WSEventType
    room_id: str
    target_user_id: int              # User whose balance triggered warning/cutoff
    message: str
    remaining_tokens: int            # Tokens remaining for target_user_id
    duration_seconds: Optional[int] = None  # Included when event is CALL_TERMINATED