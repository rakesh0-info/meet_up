from datetime import date, datetime, time

import stripe
import os
import uuid
from pathlib import Path
from fastapi import APIRouter, File, HTTPException, Depends, UploadFile, status,Form
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from requestmodel.subcription import SubscriptionPlanCreate

from dotenv import load_dotenv
from dataBase_Model.user_model import User
from enums import roleEnum
from database import get_db
from security.role_authenticated import require_roles
from dataBase_Model.subscription_db import SubscriptionPlan
from dataBase_Model.video_call_subscription import Video_Call_Subscription
from dataBase_Model.video_call import VideoCall
from enums.plan_status import status as PlanStatus

from enums.call_status import CallStatus



load_dotenv()

STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY")

if not STRIPE_SECRET_KEY:
    raise RuntimeError("STRIPE_SECRET_KEY is not set in environment variables.")

stripe.api_key=STRIPE_SECRET_KEY


router=APIRouter(prefix="/api/v1/admin")





@router.get("/admin_dashboard")
async def admin_dashboard(
    db: Session = Depends(get_db), 
    curr: User = Depends(require_roles(roleEnum.Role.ADMIN))
):
    try:
        # 1. Fetch all users and calculate token stats
        users = db.query(User).all()
        
        user_data = []
        for user in users:
            subs = db.query(Video_Call_Subscription).filter(
                Video_Call_Subscription.user_id == user.id
            ).all()
            
            total_allocated = sum(getattr(sub, "token_amount", 0) for sub in subs) if subs else 0
            current_balance = user.token_balance
            tokens_used = max(0, total_allocated - current_balance)
            
            user_data.append({
                "id": user.id,
                "name": getattr(user, "name", "N/A"),
                "email": user.email,
                "role": getattr(user, "role", None),
                "current_token_balance": current_balance,
                "tokens_allocated": total_allocated,
                "tokens_used": tokens_used
            })

        # 2. Daily token usage calculation
        today_start = datetime.combine(datetime.utcnow().date(), time.min)
        today_end = datetime.combine(datetime.utcnow().date(), time.max)

        today_tokens_used = (
            db.query(func.coalesce(func.sum(VideoCall.tokens_consumed), 0))
            .filter(VideoCall.start_time >= today_start, VideoCall.start_time <= today_end)
            .scalar()
            or 0
        )

        
        calls = db.query(VideoCall).filter(
    or_(
        VideoCall.status == CallStatus.COMPLETED,
        VideoCall.status == CallStatus.TERMINATED_NO_TOKENS
    )
).order_by(VideoCall.start_time.desc()).all()
        
        calls_data = []
        for call in calls:
          
            sender_id = getattr(call, "sender_id", None) or getattr(call, "caller_id", None)
            receiver_id = getattr(call, "receiver_id", None)
            
           
            sender = db.query(User).filter(User.id == sender_id).first() if sender_id else None
            receiver = db.query(User).filter(User.id == receiver_id).first() if receiver_id else None
            
            calls_data.append({
                "room_id": getattr(call, "room_id", "N/A"),
                "status": str(getattr(call, "status", "UNKNOWN")),
                "sender_name": getattr(sender, "name", None) or getattr(sender, "email", "Unknown Sender"),
                "receiver_name": getattr(receiver, "name", None) or getattr(receiver, "email", "Unknown Receiver"),
                "tokens_consumed": getattr(call, "tokens_consumed", 0),
                "start_time": getattr(call, "start_time", None),
                "end_time": getattr(call, "end_time", None),
                "duration_seconds": getattr(call, "duration_seconds", 0)
            })

        return {
            "users": user_data,
            "total_users": len(users),
            "total_tokens_used_today": today_tokens_used,
            "calls": calls_data
        }

    except Exception as e:
        print(f"[ADMIN DASHBOARD ERROR]: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Dashboard calculation error: {str(e)}"
        )


@router.post("/add_new_plan", status_code=status.HTTP_201_CREATED)
async def add_new_plan(
    payload: SubscriptionPlanCreate,
    current_user: User = Depends(require_roles(roleEnum.Role.ADMIN)),
    db: Session = Depends(get_db)
):
    try:
        existing_plan = db.query(SubscriptionPlan).filter(
            func.lower(SubscriptionPlan.name) == payload.name.strip().lower()
        ).first()
        if existing_plan:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A subscription plan with this name already exists. Use a different name.",
            )

        # 1. Create Stripe Product
        product = stripe.Product.create(
            name=payload.name,
            description=payload.description
        )

        # Convert currency amount to smallest unit (cents/paise)
        unit_amount_cents = int(round(payload.amount_to_pay * 100))

        # 2. Create Stripe Price
        price = stripe.Price.create(
            product=product.id,
            unit_amount=unit_amount_cents,
            currency="inr"
        )

        # 3. Save plan in database
        new_plan = SubscriptionPlan(
            name=payload.name,
            token_amount=payload.token_balance,
            amount_to_pay=payload.amount_to_pay,
            currency="inr",
            stripe_product_id=product.id,
            stripe_price_id=price.id
        )

        db.add(new_plan)
        db.commit()
        db.refresh(new_plan)

        return {
            "message": "Plan created successfully",
            "plan_id": new_plan.id,
            "name": new_plan.name,
            "token_amount": new_plan.token_amount,
            "amount_to_pay": new_plan.amount_to_pay,
            "currency": new_plan.currency,
            "stripe_product_id": new_plan.stripe_product_id,
            "stripe_price_id": new_plan.stripe_price_id
        }

    except HTTPException:
        db.rollback()
        raise

    except stripe.StripeError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Stripe Error: {str(e)}"
        )

    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A subscription plan with this name already exists. Use a different name.",
        )

    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create plan: {str(e)}"
        )