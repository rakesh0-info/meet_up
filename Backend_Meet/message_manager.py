from fastapi import WebSocket, HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session
from typing import Dict
from dataBase_Model.notifiactionModel import Notification
from dataBase_Model.user_model import User
from dataBase_Model.chatModel import Chat_M
from dataBase_Model.friend_request import FriendRequest
from enums.Request_Status import re_status
from datetime import datetime
from service.notification_service import create_notification


class msg_connectionManager:
    def __init__(self):
        self.active_connections: Dict[int, WebSocket] = {}

    async def connect(self, user_id: int, websocket: WebSocket, db: Session = None):
        await websocket.accept()
        self.active_connections[user_id] = websocket

        # Send pending unread notifications upon connection
        if db:
            unread_notifications = (
                db.query(Notification)
                .filter(
                    Notification.user_id == user_id,
                    Notification.is_read == False,
                )
                .order_by(Notification.created_at.asc())
                .all()
            )

            for notif in unread_notifications:
                await websocket.send_json(
                    {
                        "id": notif.id,
                        "message": notif.message,
                        "notification_type": notif.notification_type,
                        "is_read": notif.is_read,
                        "created_at": notif.created_at.isoformat(),
                    }
                )


    def disconnect(self, user_id: int):
        if user_id in self.active_connections:
            del self.active_connections[user_id]


    async def send_personal_message(self, message: dict, user_id: int):
        """Sends a JSON websocket payload directly to a specific user if they are online."""
        if user_id in self.active_connections:
            websocket = self.active_connections[user_id]
            try:
                await websocket.send_json(message)
                return True
            except Exception:
                self.disconnect(user_id)
                return False
        return False

    async def send_private_message(
        self, sender_id: int, recipient_id: int, message: str, db: Session
    ) -> bool:
        sender = db.query(User).filter(User.id == sender_id).first()
        receiver = db.query(User).filter(User.id == recipient_id).first()

        if not sender or not receiver:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Sender or Receiver not found",
            )

        if sender.id == receiver.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Messaging yourself is not allowed.",
            )

        if sender.role != receiver.role:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Messaging users with different roles is not allowed.",
            )

        # Enforce Friendship Requirement
        friendship = db.query(FriendRequest).filter(
            or_(
                and_(FriendRequest.sender_id == sender_id, FriendRequest.receiver_id == recipient_id),
                and_(FriendRequest.sender_id == recipient_id, FriendRequest.receiver_id == sender_id)
            ),
            FriendRequest.request_status == re_status.ACCEPT 
        ).first()

        if not friendship:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You must be friends with this user to send messages."
            )

        is_online = recipient_id in self.active_connections

        # Save Chat Message
        newChat = Chat_M(
            sender_id=sender_id,
            receiver_id=recipient_id,
            message=message,
            is_read=is_online,
            sent_at=datetime.utcnow()
        )
        db.add(newChat)
        
        # Save Notification Record to Database
        notif = create_notification(
            db=db,
            user_id=recipient_id,
            sender_id=sender_id,
            message=f"New message arrive from {sender.name}",
            notification_type="MESSAGE_NOTIFICATION",
        )

        db.commit()
        db.refresh(newChat)

        # If online, push unified payload via WebSocket
        if is_online:
            websocket = self.active_connections[recipient_id]
            try:
                await websocket.send_json(
                    {
                        "event": "NEW_PRIVATE_MESSAGE",
                        "chat": {
                            "sender_id": sender_id,
                            "receiver_id": recipient_id,
                            "message": message,
                            "is_read": True,
                            "sent_at": newChat.sent_at.isoformat(),
                        },
                        "notification": {
                            "id": notif.id if notif and hasattr(notif, "id") else None,
                            "message": f"New message arrive from {sender.name}",
                            "notification_type": "MESSAGE_NOTIFICATION",
                            "is_read": False,
                            "created_at": datetime.utcnow().isoformat(),
                        }
                    }
                )
                newChat.is_read = True
                db.commit()
                return True
            except Exception:
                self.disconnect(recipient_id)
                return False

        return False