from sqlalchemy import Column, Integer, String
from database import Base

class SubscriptionPlan(Base):
    __tablename__ = "subscription_plans"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(200), nullable=False, unique=True)
    token_amount = Column(Integer, nullable=False)
    amount_to_pay=Column(Integer,nullable=False)
    currency = Column(String(100), default="inr", nullable=False)
    stripe_price_id = Column(String(200), nullable=False)
    stripe_product_id = Column(String(200), nullable=False)