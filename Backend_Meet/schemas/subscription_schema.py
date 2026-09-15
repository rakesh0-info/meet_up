# schemas/subscription_schema.py
from pydantic import BaseModel
from datetime import datetime
from enums.plan_status import status

class PlanCreate(BaseModel):
    name: str
    token_amount: int
    currency: str = "inr"
    stripe_price_id: str
    stripe_product_id: str

class PlanResponse(PlanCreate):
    id: int

    class Config:
        from_attributes = True

class BuySubscriptionRequest(BaseModel):
    plan_id: int
    stripe_payment_id: str

class SubscriptionResponse(BaseModel):
    id: int
    user_id: int
    stripe_payment_id: str
    status: status
    token_amount: int
    created_at: datetime

    class Config:
        from_attributes = True