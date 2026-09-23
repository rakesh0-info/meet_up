# task.py

from datetime import datetime
import json
import redis
from sqlalchemy.orm import Session
from celery_con.celery_config import celery_app
from database import SessionLocal

# Database Models
from dataBase_Model.document_rag import DocumentChat
from dataBase_Model.user_model import User
from dataBase_Model.video_call_subscription import Video_Call_Subscription
from enums.plan_status import status as PlanStatus
import os
from dotenv  import load_dotenv

# Services
from service.notification_service import create_notification
load_dotenv()

# Redis Configuration for Celery Workers
REDIS_URL = os.getenv("REDIS_URL")  # Update if your Redis URL/port differs
CHANNEL = "notifications"              # Must match your WebSocket pub/sub channel

def publish_notification_sync(user_id: int, notification_data: dict):
    """Publish notification payload to Redis synchronously from a Celery worker."""
    try:
        client = redis.from_url(REDIS_URL, decode_responses=True)
        client.publish(
            CHANNEL,
            json.dumps({"user_id": user_id, "notification": notification_data})
        )
        client.close()
    except Exception as exc:
        print(f"Failed to publish notification to Redis from Celery: {exc}")



@celery_app.task(name="daily_subscription_cheackup")
def daily_subscription_cheackup():
    db: Session = SessionLocal()
    try:
        expired_subscriptions = (
            db.query(Video_Call_Subscription)
            .join(User, User.id == Video_Call_Subscription.user_id)
            .filter(
                Video_Call_Subscription.status == PlanStatus.ACTIVE,
                User.token_balance <= 0
            )
            .all()
        )

        for sub in expired_subscriptions:
            sub.status = PlanStatus.EXPIRED

            notification = create_notification(
                db=db,
                user_id=sub.user_id,
                message="Your active subscription status has expired because your token balance is 0. Please top up to continue.",
                notification_type="SYSTEM_NOTIFICATION_TOKEN_EXPIRED"
            )
            
            # Broadcast real-time event to Redis
            publish_notification_sync(sub.user_id, {
                "id": notification.id,
                "user_id": notification.user_id,
                "message": notification.message,
                "notification_type": notification.notification_type,
                "room_id": notification.room_id,
                "is_read": notification.is_read,
                "created_at": notification.created_at.isoformat()
            })

        # Commit everything all at once at the end
        db.commit()
        print(f"Daily subscription cleanup complete. Processed {len(expired_subscriptions)} expired subscriptions.")

    except Exception as e:
        db.rollback()
        print(f"Failed to execute daily subscription cleanup: {e}")
    finally:
        db.close()