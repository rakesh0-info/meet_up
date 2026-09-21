import asyncio
import json
import redis  # synchronous redis client for sync contexts
import redis.asyncio as aioredis

from dataBase_Model.notifiactionModel import Notification
from notification_manager import notification_manager
from rediss.redis_cofig import REDIS_URL

CHANNEL = "notifications"


def create_notification(db, user_id, sender_id, message, notification_type, room_id=None):
    notification = Notification(
        user_id=int(user_id),
        sender_id=sender_id,
        message=str(message),
        notification_type=str(notification_type),
        room_id=room_id
    )
    db.add(notification)
    db.flush()
    db.commit()
    db.refresh(notification)
    
    notification_payload = {
        "id": notification.id,
        "user_id": notification.user_id,
        # "sender_id":notification.user_id,
        "message": notification.message,
        "notification_type": notification.notification_type,
        "room_id": notification.room_id,
        "sender_id": sender_id,
        "is_read": notification.is_read,
        "created_at": notification.created_at.isoformat(),
    }

    # Try publishing via async loop if available, otherwise fallback to synchronous Redis publish
    try:
        loop = asyncio.get_running_loop()
        if loop.is_running():
            loop.create_task(_publish_notification_async(int(user_id), notification_payload))
        else:
            _publish_notification_sync(int(user_id), notification_payload)
    except RuntimeError:
        # No running event loop (e.g., running inside a Celery worker thread)
        _publish_notification_sync(int(user_id), notification_payload)

    return notification


async def _publish_notification_async(user_id: int, notification: dict):
    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        await client.publish(
            CHANNEL,
            json.dumps({"user_id": user_id, "notification": notification}),
        )
    except Exception as exc:
        print(f"Async notification publish failed, using local delivery: {exc}")
        await notification_manager.send_to_user(user_id, notification)
    finally:
        await client.aclose()


def _publish_notification_sync(user_id: int, notification: dict):
    """Synchronous fallback for Celery workers or background sync threads."""
    try:
        client = redis.from_url(REDIS_URL, decode_responses=True)
        client.publish(
            CHANNEL,
            json.dumps({"user_id": user_id, "notification": notification}),
        )
        client.close()
    except Exception as exc:
        print(f"Sync notification publish failed: {exc}")