import asyncio
import json
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler  # Added import

from database import engine, SessionLocal, Base
from controller.adminController import router as admin_router
from controller.publicController import router as public_router
from controller.call_controller import router as call_router
from controller.chatController import router as chat_router
from controller.notificationController import (
    router as notification_router,
    notification_manager, 
)

from service.notification_listener import notification_listener
from task import daily_subscription_cheackup  
import admin_seed


Base.metadata.create_all(bind=engine)


@asynccontextmanager
async def lifespan(app: FastAPI):
  
    db = SessionLocal()
    try:
        admin_seed.seed_admin_user(db)
    finally:
        db.close()


    listener_task = asyncio.create_task(
        notification_listener(notification_manager)
    )
    print("🚀 Notification listener started")

  
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        daily_subscription_cheackup.delay,  
        "cron", 
        # hour=17, 
        minute=10, 
        timezone="Asia/Kolkata"
    )
    scheduler.start()
    print("⏰ APScheduler started (Daily subscription checkup scheduled for 5:00 PM IST)")

    try:
        yield
    finally:
      
        scheduler.shutdown()
        print("🛑 APScheduler shut down")

        listener_task.cancel()
        try:
            await listener_task
        except asyncio.CancelledError:
            pass
        print("🛑 Notification listener stopped")


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, you can replace "*" with your frontend URL if needed, but "*" allows all local testing ports
    allow_credentials=True,
    allow_methods=["*"],  # Allows GET, POST, PUT, DELETE, OPTIONS, etc.
    allow_headers=["*"],  # Allows all headers (Authorization, Content-Type, etc.)
)

app.include_router(admin_router)
app.include_router(public_router)
app.include_router(notification_router)
app.include_router(call_router)
app.include_router(chat_router)