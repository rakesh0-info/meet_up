# schemas/user_schema.py
from pydantic import BaseModel, EmailStr, Field
from datetime import datetime
from typing import Optional
from enums.roleEnum import Role

class UserRegister(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    email: EmailStr
    password: str = Field(..., min_length=6)

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class VerifyOTP(BaseModel):
    email: EmailStr
    otp: str

class UserProfileUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=100)

class ChangePassword(BaseModel):
    old_password: str
    new_password: str = Field(..., min_length=6)

class UserResponse(BaseModel):
    id: int
    name: str
    email: EmailStr
    role: Role
    is_verified: bool
    token_balance: int
    created_at: datetime

    class Config:
        from_attributes = True

