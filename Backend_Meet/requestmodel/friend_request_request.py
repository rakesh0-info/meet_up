from pydantic import BaseModel, EmailStr


class friend_request_Model(BaseModel):
    sender_id:int
    status:str
