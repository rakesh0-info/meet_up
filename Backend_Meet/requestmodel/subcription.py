# subcription.py
from typing import Optional
from pydantic import BaseModel


class SubscriptionPlanCreate(BaseModel):
    name: str
    description: Optional[str] = None
    token_balance: int  # Fixed: changed '=' to ':'
    amount_to_pay: int