
from pydantic import BaseModel

class MarkSeenRequest(BaseModel):
    sender_id: int 