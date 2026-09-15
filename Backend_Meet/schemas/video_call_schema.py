# schemas/video_call_schema.py
from pydantic import BaseModel
from datetime import datetime
from typing import Optional
from enums.call_status import CallStatus

class InitiateCallRequest(BaseModel):
    receiver_id: int

class InitiateCallResponse(BaseModel):
    room_id: str
    sender_id: int
    receiver_id: int
    call_link: str

class CallPreCheckResponse(BaseModel):
    can_connect: bool
    sender_tokens: int
    receiver_tokens: int
    message: str

class SaveTranscriptRequest(BaseModel):
    room_id: str
    translation: str

class GenerateSummaryRequest(BaseModel):
    room_id: str
    transcript: Optional[str] = None  # Optional if already saved in call record

class CallSummaryResponse(BaseModel):
    room_id: str
    summary: str
    translation: Optional[str] = None

class VideoCallResponse(BaseModel):
    id: int
    room_id: str
    sender_id: int
    receiver_id: int
    status: CallStatus
    start_time: datetime
    end_time: Optional[datetime] = None
    duration_seconds: int
    tokens_consumed: int
    translation: Optional[str] = None
    summary: Optional[str] = None

    class Config:
        from_attributes = True