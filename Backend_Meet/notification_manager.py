from typing import Dict, List, Optional
from fastapi import WebSocket
from sqlalchemy.orm import Session
from dataBase_Model.notifiactionModel import Notification


class NotificationManager:

    def __init__(self):
        self.connections: Dict[int, List[WebSocket]] = {}

    async def connect(
        self,
        user_id: int,
        websocket: WebSocket,
        db: Session = None,
    ):
        await websocket.accept()
        self.connections.setdefault(user_id, []).append(websocket)
        print(f"Notification WebSocket connected: user={user_id}")

        # If DB session is provided, send all pending unread notifications
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
                        "room_id": notif.room_id,
                        "is_read": notif.is_read,
                        "created_at": notif.created_at.isoformat(),
                    }
                )

    def disconnect(self, user_id: int, websocket: Optional[WebSocket] = None):
        if websocket is None:
            self.connections.pop(user_id, None)
        elif user_id in self.connections:
            self.connections[user_id] = [
                connection
                for connection in self.connections[user_id]
                if connection is not websocket
            ]
            if not self.connections[user_id]:
                self.connections.pop(user_id, None)
        print(f"Notification WebSocket disconnected: user={user_id}")

    async def send_to_user(
        self,
        user_id: int,
        notification: dict,
    ):
        websockets = list(self.connections.get(user_id, []))
        if not websockets:
            return

        for websocket in websockets:
            try:
                await websocket.send_json(notification)
            except Exception:
                self.disconnect(user_id, websocket)


notification_manager = NotificationManager()