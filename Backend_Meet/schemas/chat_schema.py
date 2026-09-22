from pydantic import BaseModel, EmailStr,field_validator
from typing import Optional, List

from datetime import date

class Chat(BaseModel):
    id:int
    sender_id:int
    receiver_id:int
    message:str
    is_read:bool
    send_at:date

