import asyncio
import json

import redis.asyncio as redis

from notification_manager import NotificationManager
from rediss.redis_cofig import REDIS_URL

CHANNEL = "notifications"


async def notification_listener(
    manager: NotificationManager,
):

    redis_client = redis.from_url(
        REDIS_URL,
        decode_responses=True,
    )

    pubsub = redis_client.pubsub()

    try:
        await pubsub.subscribe(CHANNEL)
        print("Notification listener started")

        async for message in pubsub.listen():

            if message["type"] != "message":
                continue

            data = json.loads(message["data"])

            user_id = data["user_id"]

            notification = data["notification"]

            await manager.send_to_user(
                user_id,
                notification,
            )

    except asyncio.CancelledError:
        print("Notification listener stopped")

    except Exception as exc:
        print(f"Notification listener unavailable: {exc}")

    finally:
        try:
            await pubsub.unsubscribe(CHANNEL)
            await pubsub.close()
            await redis_client.aclose()
        except Exception as exc:
            print(f"Notification listener cleanup failed: {exc}")