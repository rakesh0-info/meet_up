from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from sqlalchemy.orm import Session

from dataBase_Model.friend_request import FriendRequest
from dataBase_Model.notifiactionModel import Notification
from dataBase_Model.user_model import User
from database import get_db
from enums.Request_Status import re_status
from enums.roleEnum import Role
from notification_manager import notification_manager
from security.role_authenticated import require_roles, get_websocket_user

router = APIRouter(
    prefix="/api/v1/notifications",
    tags=["Notifications"],
)

@router.websocket("/ws/{user_id}")
async def notification_websocket(
    websocket: WebSocket,
    user_id: int,
    token: str = Query(...),
    db: Session = Depends(get_db),
):
    # Validate token for WebSocket connection
    current_user = await get_websocket_user(websocket, token, db)
    if not current_user:
        return
    if current_user.id != user_id:
        await websocket.close(code=4001, reason="Unauthorized connection")
        return

    # Pass DB session to deliver unread offline notifications on connect
    await notification_manager.connect(
        user_id=user_id,
        websocket=websocket,
        db=db,
    )

    try:
        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        notification_manager.disconnect(user_id, websocket)

    except Exception:
        notification_manager.disconnect(user_id, websocket)


# notificationController_4.py

@router.get("/unread")
async def get_unread_notifications(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER, Role.ADMIN)),
):
    unread = (
        db.query(Notification)
        .filter(
            Notification.user_id == current_user.id,
            Notification.is_read == False,
        )
        .order_by(Notification.created_at.desc())
        .all()
    )
    
    response = []
    for notif in unread:
    
        response.append({
            "id": notif.id,
            "user_id": notif.user_id,
            "sender_id": notif.sender_id,
            "message": notif.message,
            "notification_type": notif.notification_type,
            "room_id": notif.room_id,  # ADDED: Include room_id in response
            "is_read": notif.is_read,
            "created_at": notif.created_at,
            
        })

    return response


@router.patch("/{notification_id}/read")
async def mark_notification_read(
    notification_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER, Role.ADMIN)),
):
    notification = (
        db.query(Notification)
        .filter(
            Notification.id == notification_id,
            Notification.user_id == current_user.id,
        )
        .first()
    )

    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")

    notification.is_read = True
    db.commit()

    return {"message": "Notification marked as read"}