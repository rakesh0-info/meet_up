from typing import Dict, List
from fastapi import WebSocket


class CallManager:
    def __init__(self):
        # Maps room_id -> list of active user connections: [{"websocket": ws, "user_id": uid}]
        self.active_connections: Dict[str, List[Dict]] = {}
        # Buffer transcripts per active room
        self.room_transcripts: Dict[str, List[str]] = {}

    async def connect(self, room_id: str, websocket: WebSocket, user_id: int):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
        self.active_connections[room_id].append({
            "websocket": websocket,
            "user_id": user_id
        })
        if room_id not in self.room_transcripts:
            self.room_transcripts[room_id] = []

    def disconnect(self, room_id: str, websocket: WebSocket):
        if room_id in self.active_connections:
            self.active_connections[room_id] = [
                conn for conn in self.active_connections[room_id]
                if conn["websocket"] != websocket
            ]
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]

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