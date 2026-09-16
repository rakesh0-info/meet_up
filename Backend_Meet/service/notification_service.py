import json

import redis

from sqlalchemy.orm import Session

from dataBase_Model.notifiactionModel import Notification


REDIS_URL = "redis://localhost:6379/4"

redis_client = redis.Redis.from_url(
    REDIS_URL,
    decode_responses=True,
)


def create_notification(db: Session, user_id: int, message: str, notification_type: str, room_id: str = None):
    notification = Notification(
        user_id=user_id,
        message=message,
        notification_type=notification_type,
        room_id=room_id
    )
    db.add(notification)
    db.commit()
    db.refresh(notification)

    # Send real-time event
    redis_client.publish(
        "notifications",
        json.dumps(
            {
                "user_id": user_id,
                "notification": {
                    "id": notification.id,
                    "message": notification.message,
                    "notification_type": notification.notification_type,
                    "is_read": notification.is_read,
                    "created_at": notification.created_at.isoformat(),
                },
            }
        ),
    )

    return notification