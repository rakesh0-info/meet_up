from pydantic import BaseModel, EmailStr

class otp_req(BaseModel):
    email: EmailStr  
    otp_input:str