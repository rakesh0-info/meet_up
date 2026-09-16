from sqlalchemy.orm import Session
from sqlalchemy import or_, and_
from dataBase_Model.friend_request import FriendRequest
from enums.Request_Status import re_status

def are_users_friends(db: Session, user1_id: int, user2_id: int) -> bool:
    """Verifies if two users have an accepted friendship status."""
    friendship = db.query(FriendRequest).filter(
        and_(
            FriendRequest.request_status == re_status.ACCEPT,
            or_(
                and_(FriendRequest.sender_id == user1_id, FriendRequest.receiver_id == user2_id),
                and_(FriendRequest.sender_id == user2_id, FriendRequest.receiver_id == user1_id),
            )
        )
    ).first()
    
    return friendship is not None