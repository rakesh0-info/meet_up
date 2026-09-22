from pydantic import BaseModel

class SendMessage(BaseModel):
    receiver_id: int
    message: str