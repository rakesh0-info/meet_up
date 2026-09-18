import os
from datetime import datetime
from dotenv import load_dotenv
from sqlalchemy.orm import Session
from dataBase_Model.user_model import User
from enums.roleEnum import Role
from util_validate.password_security import hash_password

load_dotenv()
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")

def seed_admin_user(db: Session):
    if not ADMIN_EMAIL or not ADMIN_PASSWORD:
        raise RuntimeError(
            "ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required."
        )

    admin_email = ADMIN_EMAIL.strip().lower()
    existing_admin = db.query(User).filter(User.email == admin_email).first()

    if not existing_admin:
        hashed_password = hash_password(ADMIN_PASSWORD)
        admin_user = User(
            name="admin",
            email=admin_email,
            password=hashed_password,
            role=Role.ADMIN,
            is_verified=True,
            token_balance=999999999,
            created_at=datetime.utcnow(),
        )
        db.add(admin_user)
        db.commit()
        print("Default Admin account created successfully.")
    else:
        print("Admin account already exists. Skipping startup seeding.")