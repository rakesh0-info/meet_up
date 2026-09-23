from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, Enum, DateTime
from sqlalchemy.orm import relationship
from database import Base
from enums.roleEnum import Role
from dataBase_Model.chatModel import Chat_M

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    password = Column(String, nullable=False)
    
    role =Column(
        Enum(Role, name="role", schema="Meet_up", inherit_schema=True),
        default=Role.USER,
        nullable=False
    )
    
    otp = Column(String, nullable=True)
    otp_expiry = Column(DateTime, nullable=True)
    is_verified = Column(Boolean, default=False, nullable=False)
    
    # Token Wallet
    token_balance = Column(Integer, default=0, nullable=False)
    
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # is_forget_pass=Column(Boolean,default= False)
    secret_key=Column(String(200),nullable=True)

    # Relationships
    sent_messages = relationship("Chat_M", foreign_keys=[Chat_M.sender_id], back_populates="sender")
    received_messages = relationship("Chat_M", foreign_keys=[Chat_M.receiver_id], back_populates="receiver")
    subscriptions = relationship("Video_Call_Subscription", back_populates="user", cascade="all, delete-orphan")
    notifications = relationship(
        "Notification", 
        foreign_keys="Notification.user_id", 
        back_populates="user",
        cascade="all, delete-orphan"
    )
    document_chats = relationship("DocumentChat", back_populates="user", cascade="all, delete-orphan")