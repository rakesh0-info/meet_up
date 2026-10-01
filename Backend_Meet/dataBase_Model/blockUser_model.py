from datetime import datetime
from sqlalchemy import Column, Integer, DateTime, ForeignKey, UniqueConstraint, Index
from sqlalchemy.orm import relationship
from database import Base

class UserBlock(Base):
    __tablename__ = "user_blocks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    
    # Who initiated the block
    blocker_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    
    # Who got blocked
    blocked_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    
    # When the block occurred
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


    blocker = relationship("User", foreign_keys=[blocker_id], backref="blocked_users")
    blocked = relationship("User", foreign_keys=[blocked_id], backref="blocked_by")

   
    __table_args__ = (
        UniqueConstraint("blocker_id", "blocked_id", name="uq_blocker_blocked_pair"),
        Index("idx_blocker_lookup", "blocker_id", "blocked_id"),
    )