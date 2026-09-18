import asyncio
import json
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware  # Added import

from database import engine, SessionLocal, Base
from controller.adminController import router as admin_router
from controller.publicController import router as public_router
from controller.call_controller import router as call_router
from controller.notificationController import (
    router as notification_router,
    notification_manager,  # Single source of truth instance
)

from service.notification_listener import notification_listener
import admin_seed


Base.metadata.create_all(bind=engine)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = SessionLocal()
    try:
        admin_seed.seed_admin_user(db)
    finally:
        db.close()

    # Pass the actual notification_manager object instance
    listener_task = asyncio.create_task(
        notification_listener(notification_manager)
    )

    print("🚀 Notification listener started")

    try:
        yield
    finally:
        listener_task.cancel()
        try:
            await listener_task
        except asyncio.CancelledError:
            pass
        print("🛑 Notification listener stopped")


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allows all methods (GET, POST, PUT, DELETE, etc.)
    allow_headers=["*"],  # Allows all headers (Authorization, Content-Type, etc.)
)


             # Match your channel name




app.include_router(admin_router)
app.include_router(public_router)
app.include_router(notification_router)
app.include_router(call_router)