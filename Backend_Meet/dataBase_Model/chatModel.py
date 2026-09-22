from sqlalchemy import Column, Integer, Text, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, relationship
from datetime import datetime
from database import Base


class Chat_M(Base):
     __tablename__ = "chats"
     id = Column(Integer, primary_key=True, index=True,autoincrement=True)
     sender_id = Column(Integer, ForeignKey("users.id"), nullable=False)
     receiver_id = Column(Integer, ForeignKey("users.id"), nullable=False)
     message = Column(Text, nullable=False)
     is_read = Column(Boolean, default=False, nullable=False)
     sent_at = Column(DateTime, default=datetime.utcnow, nullable=False)


     sender = relationship("User", foreign_keys=[sender_id], back_populates="sent_messages")
     receiver = relationship("User", foreign_keys=[receiver_id], back_populates="received_messages")

