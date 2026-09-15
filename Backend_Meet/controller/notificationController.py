from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from sqlalchemy.orm import Session

from dataBase_Model.notifiactionModel import Notification
from dataBase_Model.user_model import User
from database import get_db
from enums.roleEnum import Role
from notification_manager import NotificationManager
from security.role_authenticated import require_roles, get_websocket_user

router = APIRouter(
    prefix="/api/v1/notifications",
    tags=["Notifications"],
)

# Shared manager instance or import from your main app module
notification_manager = NotificationManager()


@router.websocket("/ws/{user_id}")
async def notification_websocket(
    websocket: WebSocket,
    user_id: int,
    token: str = Query(...),
    db: Session = Depends(get_db),
):
    # Validate token for WebSocket connection
    current_user = await get_websocket_user(websocket, token, db)
    if not current_user or current_user.id != user_id:
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
        notification_manager.disconnect(user_id)

    except Exception:
        notification_manager.disconnect(user_id)


@router.get("/unread")
async def get_unread_notifications(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER, Role.ADMIN)),
):
    """Fetch unread notifications via REST API."""
    unread = (
        db.query(Notification)
        .filter(
            Notification.user_id == current_user.id,
            Notification.is_read == False,
        )
        .order_by(Notification.created_at.desc())
        .all()
    )
    return unread


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