from pydantic import BaseModel

class CallRequestPayload(BaseModel):
    receiver_id: int

class CallResponsePayload(BaseModel):
    room_id: str
    accepted: bool