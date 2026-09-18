import os
import time
from typing import Optional
import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status as http_status
from fastapi.responses import PlainTextResponse
from jose import jwt
from sqlalchemy.orm import Session
from dotenv import load_dotenv

from database import get_db
from dataBase_Model.video_call import VideoCall
from dataBase_Model.user_model import User
from security.role_authenticated import get_websocket_user, require_roles
from enums.roleEnum import Role
from enums.call_status import CallStatus

from call_manager import call_manager
from service.friend_service import are_users_friends
from service.notification_service import create_notification
from service.call_service import finalize_call_and_summarize
from schemas.call_schema import CallRequestPayload, CallResponsePayload
from dataBase_Model.video_call_subscription import Video_Call_Subscription
from enums.plan_status import status

router = APIRouter(prefix="/api/v1/call", tags=["Call Management"])

load_dotenv()

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")
# Fixed: Pulls correctly from your .env file instead of a placeholder
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "wss://my-app-wsr7to1b.livekit.cloud")


def generate_livekit_token(room_name: str, identity: str, name: str = None) -> str:
    """Generates a signed LiveKit JWT token for joining a video call session."""
    if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="LIVEKIT_API_KEY or LIVEKIT_API_SECRET configuration missing."
        )

    now = int(time.time())
    exp = now + (24 * 3600)

    payload = {
        "iss": LIVEKIT_API_KEY,
        "sub": identity,
        "nbf": now - 5,
        "exp": exp,
        "name": name or identity,
        "video": {
            "room": room_name,
            "roomJoin": True,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
        }
    }

    return jwt.encode(payload, LIVEKIT_API_SECRET, algorithm="HS256")


@router.get("/get-livekit-token")
@router.get("/get-videosdk-token")
def get_livekit_token(
    room_id: Optional[str] = None, 
    current_user = Depends(require_roles(Role.USER))
):
    """
    Generates a LiveKit access token and returns the required connection parameters.
    """
    try:
        room_name = room_id if room_id else f"room_{uuid.uuid4().hex[:12]}"
        
        token = generate_livekit_token(
            room_name=room_name,
            identity=str(current_user.id),
            name=current_user.name or current_user.email
        )
        
        return {
            "token": token,
            "url": LIVEKIT_URL,           # Standard key expected by clients
            "livekit_url": LIVEKIT_URL,   # Explicit snake_case variant
            "livekitUrl": LIVEKIT_URL,    # Explicit camelCase variant
            "room_id": room_name
        }
    except Exception as e:
        raise HTTPException(
            status_code=500, 
            detail=f"Failed to generate LiveKit token: {str(e)}"
        )


@router.post("/request_call")
async def send_call_request(
    payload: CallRequestPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER))
):
    receiver_id = payload.receiver_id

    user = db.query(Video_Call_Subscription).filter(
        Video_Call_Subscription.status == status.ACTIVE, 
        Video_Call_Subscription.user_id == current_user.id
    ).first()

    if not user:
        raise HTTPException(400, detail="you do not have any token to call")

    if current_user.id == receiver_id:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="You cannot call yourself."
        )

    if not are_users_friends(db, current_user.id, receiver_id):
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="You can only call accepted friends."
        )

    if current_user.token_balance < 10:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Insufficient token balance."
        )

    room_id = f"room_{uuid.uuid4().hex[:12]}"

    new_call = VideoCall(
        room_id=room_id,
        sender_id=current_user.id,
        receiver_id=receiver_id,
        status=CallStatus.NO_CALL,
        start_time=datetime.utcnow()
    )
    db.add(new_call)
    db.commit()

    create_notification(
        db=db,
        user_id=receiver_id,
        message=f"Incoming video call from {current_user.name or current_user.email}",
        notification_type="INCOMING_CALL",
        room_id=room_id
    )

    return {"message": "Call request sent.", "room_id": room_id, "status": "PENDING"}


@router.post("/respond_call")
async def respond_to_call(
    payload: CallResponsePayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER))
):
    call_record = db.query(VideoCall).filter(VideoCall.room_id == payload.room_id).first()

    if not call_record:
        raise HTTPException(status_code=404, detail="Call request not found.")

    if call_record.receiver_id != current_user.id:
        raise HTTPException(status_code=403, detail="Unauthorized to respond to this call.")

    if call_record.status == CallStatus.ACTIVE:
        return {
            "message": "Call already active.",
            "room_id": payload.room_id,
            "websocket_endpoint": f"/api/v1/call/ws/{payload.room_id}/{current_user.id}"
        }

    if call_record.status != CallStatus.NO_CALL:
        raise HTTPException(status_code=409, detail="This call can no longer be answered.")

    if payload.accepted:
        if current_user.token_balance < 10:
            raise HTTPException(status_code=400, detail="Insufficient tokens to join call.")

        call_record.status = CallStatus.ACTIVE
        db.commit()

        create_notification(
            db=db,
            user_id=call_record.sender_id,
            message=f"{current_user.name or current_user.email} accepted your video call.",
            notification_type="CALL_ACCEPTED",
            room_id=call_record.room_id
        )

        return {
            "message": "Call accepted.",
            "room_id": payload.room_id,
            "websocket_endpoint": f"/api/v1/call/ws/{payload.room_id}/{current_user.id}"
        }
    else:
        call_record.status = CallStatus.TERMINATED_NO_TOKENS
        db.commit()

        create_notification(
            db=db,
            user_id=call_record.sender_id,
            message=f"{current_user.name or current_user.email} rejected your video call.",
            notification_type="CALL_REJECTED",
            room_id=call_record.room_id
        )

        return {"message": "Call rejected."}


@router.websocket("/ws/{room_id}/{user_id}")
async def call_websocket(
    websocket: WebSocket,
    room_id: str,
    user_id: int,
    token: str = Query(...),
    db: Session = Depends(get_db),
):
    authenticated_user = await get_websocket_user(websocket, token, db)
    if not authenticated_user:
        return
    if authenticated_user.id != user_id:
        await websocket.close(code=4001, reason="Unauthorized connection")
        return

    call_record = db.query(VideoCall).filter(VideoCall.room_id == room_id).first()
    if not call_record or authenticated_user.id not in {
        call_record.sender_id,
        call_record.receiver_id,
    }:
        await websocket.close(code=4003, reason="Not a participant in this call")
        return

    if call_record.status != CallStatus.ACTIVE:
        await websocket.close(code=4004, reason="Call is not active")
        return

    connected = await call_manager.connect(room_id, websocket, authenticated_user.id, db=db)
    if not connected:
        return

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = (data.get("type") or "").upper()

            if msg_type in ["LIVEKIT_TRANSCRIPT", "VIDEO_SDK_TRANSCRIPT", "TRANSCRIPT", "LIVE_CAPTION"]:
                text = (data.get("text") or "").strip()
                participant_name = (
                    data.get("participantName")
                    or data.get("participant_name")
                    or data.get("speaker")
                    or f"User {authenticated_user.id}"
                )
                timestamp = data.get("timestamp")

                if text:
                    await call_manager.process_livekit_transcript(
                        room_id=room_id,
                        sender_id=authenticated_user.id,
                        participant_name=participant_name,
                        text=text,
                        timestamp=timestamp,
                    )

            elif msg_type in ["OFFER", "ANSWER", "CANDIDATE"]:
                await call_manager.send_to_peer(room_id, websocket, data)

            elif msg_type == "PING":
                await websocket.send_json({"type": "PONG"})

    except WebSocketDisconnect:
        call_manager.disconnect(room_id, websocket)

    except Exception as e:
        print(f"[CALL WS ERROR] room={room_id}, user={authenticated_user.id}, error={e}")
        try:
            call_manager.disconnect(room_id, websocket)
        except Exception:
            pass


@router.api_route("/summary/{room_id}", methods=["GET", "POST"])
async def handle_call_summary(
    room_id: str,
    payload: dict = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER))
):
    call_record = db.query(VideoCall).filter(VideoCall.room_id == room_id).first()

    if not call_record:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Call record not found."
        )

    if current_user.id not in [call_record.sender_id, call_record.receiver_id]:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Unauthorized to access this call summary."
        )

    transcript_text = payload.get("transcript") if payload and isinstance(payload, dict) else None

    if transcript_text:
        lines = [line.strip() for line in transcript_text.split("\n") if line.strip()]
        updated_record = await finalize_call_and_summarize(room_id, lines, db)
        if updated_record:
            call_record = updated_record
    elif not call_record.summary:
        buffered_lines = call_manager.get_transcripts(room_id)
        if buffered_lines:
            updated_record = await finalize_call_and_summarize(room_id, buffered_lines, db)
            if updated_record:
                call_record = updated_record

    return {
        "room_id": room_id,
        "summary": call_record.summary or "Summary is currently being generated or unavailable.",
        "duration_seconds": call_record.duration_seconds,
        "tokens_consumed": call_record.tokens_consumed,
        "status": call_record.status
    }


@router.get("/summary/{room_id}/download")
async def download_call_summary(
    room_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER))
):
    call_record = db.query(VideoCall).filter(VideoCall.room_id == room_id).first()

    if not call_record:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Call record not found."
        )

    if current_user.id not in [call_record.sender_id, call_record.receiver_id]:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Unauthorized to download this call summary."
        )

    summary = call_record.summary

    if not summary:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Call summary is not available yet."
        )

    return PlainTextResponse(
        content=summary,
        headers={"Content-Disposition": f'attachment; filename="call_summary_{room_id}.txt"'}
    )