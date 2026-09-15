import os
from typing import Any

from dotenv import load_dotenv
from fastapi import Depends, HTTPException, WebSocket, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from database import get_db
from dataBase_Model.user_model import User

load_dotenv()

oauth2_scheme = OAuth2PasswordBearer(
    tokenUrl="/api/v1/user/login"
)

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable is not set.")

ALGORITHM = os.getenv("ALGORITHM", "HS256")


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    """
    Extracts, decodes, and validates the JWT Bearer Token.
    """
    cred_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(
            token,
            SECRET_KEY,
            algorithms=[ALGORITHM]
        )
        user_email: str | None = payload.get("sub")
        token_type: str | None = payload.get("type")

        if not user_email or token_type != "access":
            raise cred_exc

    except JWTError:
        raise cred_exc

    user = db.query(User).filter(User.email == user_email).first()

    if not user:
        raise cred_exc

    return user


def get_authenticated_active_user(
    current_user: User = Depends(get_current_user)
) -> User:
    """
    Ensures that the user has completed first-time
    verification and is not using a temporary password.
    """
    if not current_user.is_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "First-time verification incomplete. "
                "Please verify OTP and update your temporary password."
            )
        )

    return current_user


def require_roles(*allowed_roles: Any):
    """
    Role verification dependency factory.
    Supports Python Enum values and raw strings.
    """
    def role_checker(
        user: User = Depends(get_authenticated_active_user)
    ) -> User:
        if user.role is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access forbidden: User has no assigned role."
            )

        user_role = (
            user.role.value
            if hasattr(user.role, "value")
            else str(user.role)
        )

        allowed_values = [
            role.value if hasattr(role, "value") else str(role)
            for role in allowed_roles
        ]

        if user_role not in allowed_values:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access forbidden: Insufficient permissions."
            )

        return user

    return role_checker


# from fastapi import WebSocket, status
# from jose import JWTError, jwt

async def get_websocket_user(
    websocket: WebSocket, 
    token: str, 
    db: Session
) -> User | None:
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return None

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return None
    except JWTError:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return None

    user = db.query(User).filter(User.email == email).first()
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return None

    return user 