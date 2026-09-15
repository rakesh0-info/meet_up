from datetime import date, datetime, time

import stripe
import os
import uuid
from pathlib import Path
from fastapi import APIRouter, File, HTTPException, Depends, UploadFile, status,Form
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from requestmodel.subcription import SubscriptionPlanCreate

from dotenv import load_dotenv
from dataBase_Model.user_model import User
from enums import roleEnum
from database import get_db
from security.role_authenticated import require_roles
from dataBase_Model.subscription_db import SubscriptionPlan
from dataBase_Model.video_call_subscription import Video_Call_Subscription
from dataBase_Model.video_call import VideoCall
# from enums.plan_status import status as staus_plan



load_dotenv()

router=APIRouter(prefix="/api/v1/admin")





@router.get("/get_all_user", status_code=status.HTTP_200_OK)
async def get_all_users_usage(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(roleEnum.Role.ADMIN))
):
   
    today_start = datetime.combine(date.today(), time.min)


    today_stats = db.query(
        func.coalesce(func.sum(VideoCall.tokens_consumed), 0).label("total_tokens_today"),
        func.coalesce(func.sum(VideoCall.duration_seconds), 0).label("total_duration_today")
    ).filter(VideoCall.created_at >= today_start).first()

   
    users = db.query(User).all()
    users_usage_list = []

    for user in users:
        # Sum calls where the user was either sender or receiver
        user_stats = db.query(
            func.coalesce(func.sum(VideoCall.tokens_consumed), 0).label("total_tokens"),
            func.coalesce(func.sum(VideoCall.duration_seconds), 0).label("total_duration"),
            func.count(VideoCall.id).label("total_calls")
        ).filter(
            or_(VideoCall.sender_id == user.id, VideoCall.receiver_id == user.id)
        ).first()

        users_usage_list.append({
            "user_id": user.id,
            "email": user.email,
            "role": user.role,
            "current_token_balance": user.token_balance,
            "total_tokens_used": float(user_stats.total_tokens),
            "total_duration_seconds": int(user_stats.total_duration),
            "total_calls_count": int(user_stats.total_calls)
        })

    # 4. Consolidated Response
    return {
        "today_summary": {
            "date": date.today().isoformat(),
            "total_tokens_consumed_today": float(today_stats.total_tokens_today),
            "total_duration_seconds_today": int(today_stats.total_duration_today)
        },
        "total_users_count": len(users_usage_list),
        "users": users_usage_list
    }


@router.post("/add_new_plan", status_code=status.HTTP_201_CREATED)
async def add_new_plan(
    payload: SubscriptionPlanCreate,
    current_user: User = Depends(require_roles(roleEnum.Role.ADMIN)),
    db: Session = Depends(get_db)
):
    try:
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

    except stripe.StripeError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Stripe Error: {str(e)}"
        )

    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create plan: {str(e)}"
        )