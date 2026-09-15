from datetime import datetime
from typing import Dict
from fastapi import WebSocket, HTTPException, status
from sqlalchemy.orm import Session

from dataBase_Model.chat_model import Chat
from dataBase_Model.user_model import User
from enums.roleEnum import Role


class ConnectionManager:
    def __init__(self):
        # Store active connections: { user_id (int): WebSocket }
        self.active_connections: Dict[int, WebSocket] = {}

    async def connect(self, user_id: int, websocket: WebSocket):
        await websocket.accept()
        self.active_connections[user_id] = websocket

    def disconnect(self, user_id: int):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
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

        if sender.role == receiver.role:
            raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Messaging between two {sender.role.value}s is not allowed.",
        )

    # If recipient is online, set is_read to True immediately
        is_online = recipient_id in self.active_connections

        new_chat = Chat(
        sender_id=sender_id,
        receiver_id=recipient_id,
        message=message,
        is_read=is_online,  # True if online/active, False if offline
        sent_at=datetime.now(),
        )
        db.add(new_chat)
        db.commit()

        if is_online:
            websocket = self.active_connections[recipient_id]
            await websocket.send_json(
            {
                "sender_id": sender_id,
                "receiver_id": recipient_id,
                "message": message,
                "is_read": True,
                "sent_at": new_chat.sent_at.isoformat(),
            }
            )
            return True
        return False

    