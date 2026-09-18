
from pydantic import BaseModel, EmailStr

class reset_pass(BaseModel):
    key :str
    email:EmailStr
    new_pass:str
    confrim_pass:str
