from datetime import datetime
from sqlalchemy import Column, Enum, Integer, String, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from database import Base

from enums.call_status import CallStatus

class VideoCall(Base):
    __tablename__ = "video_calls"

    id = Column(Integer, primary_key=True, autoincrement=True)
    room_id = Column(String(100), unique=True, nullable=False, index=True)
    
    sender_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    receiver_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    
    status = Column(
        Enum(CallStatus, name="CallStatus", schema="Meet_up", inherit_schema=True),
        default=CallStatus.NO_CALL,
        nullable=False
    )
    start_time = Column(DateTime, default=datetime.utcnow, nullable=False)
    end_time = Column(DateTime, nullable=True)
    duration_seconds = Column(Integer, default=0)
    tokens_consumed = Column(Integer, default=0)

    translation = Column(Text, nullable=True)
    summary = Column(Text, nullable=True)

    sender = relationship("User", foreign_keys=[sender_id])
    receiver = relationship("User", foreign_keys=[receiver_id])