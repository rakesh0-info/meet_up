import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI

from database import engine, SessionLocal, Base
from controller.adminController import router as admin_router
from controller.publicController import router as public_router
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

app.include_router(admin_router)
app.include_router(public_router)
app.include_router(notification_router)