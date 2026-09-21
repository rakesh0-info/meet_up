import asyncio
from datetime import datetime
from typing import Dict, List, Optional
from fastapi import WebSocket
from sqlalchemy.orm import Session

from database import get_db
from dataBase_Model.video_call import VideoCall
from dataBase_Model.user_model import User
from enums.call_status import CallStatus
from service.notification_service import create_notification


class CallManager:
    def __init__(self):
        # Maps room_id -> list of active user connections: [{"websocket": ws, "user_id": uid}]
        self.active_connections: Dict[str, List[Dict]] = {}
        # Buffer transcripts per active room
        self.room_transcripts: Dict[str, List[str]] = {}
        # Background timer tasks for per-minute token deductions per room
        self.billing_tasks: Dict[str, asyncio.Task] = {}
        self.initially_charged: Dict[str, set[int]] = {}

    async def connect(self, room_id: str, websocket: WebSocket, user_id: int, db: Session) -> bool:
            room_connections = self.active_connections.setdefault(room_id, [])
            if any(conn["user_id"] == user_id for conn in room_connections):
                await websocket.close(code=4005, reason="User is already connected")
                return False

            await websocket.accept()
            
            charged_users = self.initially_charged.setdefault(room_id, set())
            user = db.query(User).filter(User.id == user_id).with_for_update().first()
            if not user or (user_id not in charged_users and user.token_balance < 10):
                await websocket.send_json({"type": "ERROR", "message": "Insufficient tokens or user not found."})
                await websocket.close()
                return False

            if user_id not in charged_users:
                user.token_balance -= 10
                db.commit()
                charged_users.add(user_id)
                db.refresh(user)
            
            await websocket.send_json({
                "type": "BALANCE_UPDATE",
                "current_balance": user.token_balance
            })

            room_connections.append({"websocket": websocket, "user_id": user_id})
            
            if room_id not in self.room_transcripts:
                self.room_transcripts[room_id] = []

            print(f"[WS CONNECT] User {user_id} joined room {room_id}. Total active: {len(self.active_connections[room_id])}")

            # FIX: Start billing if at least 1 person is connected (or change to 2 if strict, but ensure task starts)
            if room_id not in self.billing_tasks:
                self.billing_tasks[room_id] = asyncio.create_task(
                    self.start_minute_token_billing(room_id)
        )
            return True
    def disconnect(self, room_id: str, websocket: WebSocket):
        if room_id in self.active_connections:
            self.active_connections[room_id] = [
                conn for conn in self.active_connections[room_id]
                if conn["websocket"] != websocket
            ]
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]
                # Cancel billing loop if everyone leaves
                if room_id in self.billing_tasks:
                    self.billing_tasks[room_id].cancel()
                    del self.billing_tasks[room_id]
                self.initially_charged.pop(room_id, None)

                db_gen = get_db()
                db: Session = next(db_gen)
                try:
                    call_record = db.query(VideoCall).filter(VideoCall.room_id == room_id).first()
                    if call_record and call_record.status == CallStatus.ACTIVE:
                        call_record.status = CallStatus.COMPLETED
                        call_record.end_time = datetime.utcnow()
                        db.commit()
                finally:
                    db.close()



    async def start_minute_token_billing(self, room_id: str):
        try:
            print(f"[BILLING INFO] Billing task started for room: {room_id}")
            while True:
                await asyncio.sleep(60)  # 1 minute interval

                db_gen = get_db()
                db: Session = next(db_gen)

                try:
                    call_record = db.query(VideoCall).filter(VideoCall.room_id == room_id).first()
                    if not call_record or call_record.status != CallStatus.ACTIVE:
                        print(f"[BILLING WARNING] Record not found for {room_id}")
                        continue

                    participant_ids = [conn["user_id"] for conn in self.active_connections.get(room_id, [])]
                    billed_anyone = False

                    for uid in participant_ids:
                        user = db.query(User).filter(User.id == uid).first()
                        if not user:
                            continue

                        # 1. Check if user already has 0 or fewer tokens before deducting
                        if user.token_balance <= 0:
                            create_notification(
                                db=db,
                                user_id=uid,
                                sender_id=uid,
                                message="Your token balance has run out. The call has been terminated.",
                                notification_type="CALL_ENDED_NO_TOKENS"
                            )
                            await self.broadcast_to_room(room_id, {
                                "type": "CALL_ENDED_NO_TOKENS",
                                "message": f"User {uid} ran out of tokens."
                            })
                            call_record.status = CallStatus.TERMINATED_NO_TOKENS
                            db.commit()
                            
                            for conn in list(self.active_connections.get(room_id, [])):
                                await conn["websocket"].close()
                            return

                        # 2. Deduct 10 tokens for the minute
                        updated = (
                            db.query(User)
                            .filter(
                                User.id == uid,
                                User.token_balance > 0,
                            )
                            .update(
                                {User.token_balance: User.token_balance - 10},
                                synchronize_session=False,
                            )
                        )
                        call_record.tokens_consumed += 10
                        billed_anyone = True 
                        
                        db.commit()
                        db.refresh(user)

                        print(f"[BILLING] Deducted 10 tokens from user {uid}. Balance: {user.token_balance}")
                        
                        # Send live balance update via WebSocket
                        await self.send_to_user(room_id, user.id, {
                            "type": "BALANCE_UPDATE",
                            "current_balance": user.token_balance
                        })

                        # 3. Check if the *new* balance is low or zero after deduction
                        if user.token_balance <= 0:
                            create_notification(
                                db=db,
                                user_id=uid,
                                sender_id=uid,
                                 room_id=room_id,
                                message="Your token balance has run out. The call has been terminated.",
                                notification_type="CALL_ENDED_NO_TOKENS"
                            )
                            await self.broadcast_to_room(room_id, {
                                "type": "CALL_ENDED_NO_TOKENS",
                                "message": f"User {uid} ran out of tokens."
                            })
                            call_record.status = CallStatus.TERMINATED_NO_TOKENS
                            db.commit()
                            
                            for conn in list(self.active_connections.get(room_id, [])):
                                await conn["websocket"].close()
                            return

                        elif user.token_balance <= 10:
                            create_notification(
                                db=db,
                                user_id=uid,
                                sender_id=uid,
                                room_id=room_id,
                                message=f"Warning: Your token balance is running low ({user.token_balance} tokens left).",
                                notification_type="LOW_TOKENS"
                            )

                    if billed_anyone:
                        call_record.duration_seconds += 60
                        db.commit()
                finally:
                    db.close()
        except asyncio.CancelledError:
            print(f"[BILLING] Cancelled for room {room_id}")
        except Exception as e:
            print(f"[BILLING ERROR] {e}")

    async def broadcast_to_room(self, room_id: str, message: dict):
        if room_id in self.active_connections:
            for connection in self.active_connections[room_id]:
                try:
                    await connection["websocket"].send_json(message)
                except Exception as e:
                    print(f"[WS BROADCAST ERROR] user={connection['user_id']}: {e}")

    async def send_to_user(self, room_id: str, target_user_id: int, message: dict):
        if room_id in self.active_connections:
            for connection in list(self.active_connections[room_id]):
                if connection["user_id"] == target_user_id:
                    try:
                        await connection["websocket"].send_json(message)
                    except Exception as e:
                        print(f"[WS USER SEND ERROR] user={target_user_id}: {e}")
                        self.disconnect(room_id, connection["websocket"])

    async def send_to_peer(self, room_id: str, sender_ws: WebSocket, message: dict):
        if room_id in self.active_connections:
            for connection in self.active_connections[room_id]:
                if connection["websocket"] != sender_ws:
                    try:
                        await connection["websocket"].send_json(message)
                    except Exception as e:
                        print(f"[WS PEER SEND ERROR] user={connection['user_id']}: {e}")

    async def process_livekit_transcript(
        self,
        room_id: str,
        sender_id: int,
        participant_name: str,
        text: str,
        timestamp: float = None
    ):
        """Broadcasts LiveKit real-time transcription events to all room participants."""
        formatted_entry = f"{participant_name}: {text}"
        if room_id not in self.room_transcripts:
            self.room_transcripts[room_id] = []
        self.room_transcripts[room_id].append(formatted_entry)

        if room_id in self.active_connections:
            payload = {
                "type": "LIVE_CAPTION",
                "speaker": participant_name,
                "text": text,
                "sender_id": sender_id,
                "timestamp": timestamp
            }
            for connection in self.active_connections[room_id]:
                try:
                    await connection["websocket"].send_json(payload)
                except Exception as e:
                    print(f"[WS TRANSCRIPT BROADCAST ERROR] user={connection['user_id']}: {e}")

    def get_transcripts(self, room_id: str) -> List[str]:
        return self.room_transcripts.get(room_id, [])


call_manager = CallManager()