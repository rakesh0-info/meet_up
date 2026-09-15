from datetime import datetime
from sqlalchemy import Column, Integer, String, Enum, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from database import Base
from enums.plan_status import status

class Video_Call_Subscription(Base):
    __tablename__ = "video_call_subscriptions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    stripe_payment_id = Column(String, nullable=False)
    status = Column(
        Enum(status, name="status", schema="Meet_up", inherit_schema=True),
        default=status.NOT_START,
        nullable=False
    )
    token_amount = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="subscriptions")