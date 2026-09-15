# task.py

from datetime import datetime
from sqlalchemy.orm import Session
from celery_con.celery_config import celery_app
from database import SessionLocal

# Database Models
from dataBase_Model.document_rag import DocumentChat
from dataBase_Model.user_model import User
from dataBase_Model.video_call_subscription import Video_Call_Subscription
from enums.plan_status import status as PlanStatus

# Services
from service.notification_service import create_notification


@celery_app.task(name="process_document_upload")
def process_document_upload(document_id: int):
  
    db: Session = SessionLocal()
    try:
        doc = db.query(DocumentChat).filter(DocumentChat.id == document_id).first()
        if not doc:
            print(f"Document with ID {document_id} not found.")
            return

        print(f"Processing Document ID {doc.id}: {doc.filename}")

       

        # -------------------------------------------------------------
        # 2. Notify User that document is ready for Q&A / RAG
        # -------------------------------------------------------------
        create_notification(
            db=db,
            user_id=doc.user_id,
            message=f"Your document '{doc.filename}' has been processed. You can now ask questions about it!",
            notification_type="DOCUMENT_PROCESSED"
        )
        db.commit()
        print(f"Document ID {doc.id} successfully processed!")

    except Exception as e:
        db.rollback()
        print(f"Document processing failed: {e}")
        raise
    finally:
        db.close()


@celery_app.task(name="daily_subscription_cleanup")
def daily_subscription_cleanup():

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

            create_notification(
                db=db,
                user_id=sub.user_id,
                message="Your active subscription status has expired because your token balance is 0. Please top up to continue.",
                notification_type="TOKEN_EXPIRED"
            )

        db.commit()
        print(f"Daily subscription cleanup complete. Processed {len(expired_subscriptions)} expired subscriptions.")

    except Exception as e:
        db.rollback()
        print(f"Failed to execute daily subscription cleanup: {e}")
    finally:
        db.close()