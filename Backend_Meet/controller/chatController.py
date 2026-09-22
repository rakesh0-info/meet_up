from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    status as http_status,
)
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from dataBase_Model.user_model import User
from enums.roleEnum import Role
from database import get_db
from security.role_authenticated import get_websocket_user, require_roles

from message_manager import msg_connectionManager
from requestmodel.sendMsg_request import SendMessage
from dataBase_Model.chatModel import Chat_M as Chat
from requestmodel.seen_request import MarkSeenRequest

manager = msg_connectionManager()

router = APIRouter(
    prefix="/api/v1/chats",
    tags=["Chats"],
)


@router.websocket("/ws/{user_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: int,
    token: str = None,
    db: Session = Depends(get_db),
):
    current_user = await get_websocket_user(websocket, token, db)
    if not current_user or current_user.id != user_id:
        await websocket.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return

    # Pass the DB session down to handle unread notifications queue
    await manager.connect(user_id, websocket, db=db)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(user_id)
    except Exception:
        manager.disconnect(user_id)


@router.post("/chat/send")
async def send_private(
    payload: SendMessage,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER)),
):
    try:
        await manager.send_private_message(
            sender_id=current_user.id,
            recipient_id=payload.receiver_id,
            message=payload.message,
            db=db,
        )
        return {"status": "success", "message": "Message sent successfully"}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/history")
async def get_chat_history(
    id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.ADMIN, Role.USER)),
):
    target_user = db.query(User).filter(User.id == id).first()

    if not target_user:
        raise HTTPException(404, detail="Target user not found")

    if current_user.role != target_user.role:
        raise HTTPException(
            400,
            detail="Chat history between different roles is not permitted.",
        )

    chat_history = (
        db.query(Chat)
        .filter(
            or_(
                and_(
                    Chat.sender_id == current_user.id,
                    Chat.receiver_id == target_user.id,
                ),
                and_(
                    Chat.sender_id == target_user.id,
                    Chat.receiver_id == current_user.id,
                ),
            )
        )
        .order_by(Chat.sent_at.asc())
        .all()
    )

    return {
        "chat_partner": {
            "id": target_user.id,
            "name": target_user.name,
            "email": target_user.email,
            "role": (
                target_user.role.value
                if hasattr(target_user.role, "value")
                else str(target_user.role)
            ),
        },
        "messages_count": len(chat_history),
        "messages": [
            {
                "id": msg.id,
                "sender_id": msg.sender_id,
                "receiver_id": msg.receiver_id,
                "message": msg.message,
                "is_read": msg.is_read,
                "sent_at": msg.sent_at,
            }
            for msg in chat_history
        ],
    }





@router.patch("/mark-seen")
async def mark_messages_seen(
    payload: MarkSeenRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER)),
):
    """
    Mark all unread messages from a specific sender to the current user as 'seen',
    and notify the sender in real-time via WebSocket.
    """
    try:
       
        unread_chats = db.query(Chat).filter(
            Chat.receiver_id == current_user.id,
            Chat.sender_id == payload.sender_id,
            Chat.is_read == False
        ).all()

        for chat in unread_chats:
            chat.is_read = True
        
        if unread_chats:
            db.commit()

      
        await manager.send_personal_message(
            {
                "type": "MESSAGE_SEEN",
                "reader_id": current_user.id,
                "sender_id": payload.sender_id
            },
            payload.sender_id
        )

        return {"status": "success", "marked_count": len(unread_chats)}
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )