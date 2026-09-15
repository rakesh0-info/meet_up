import asyncio
import json

import redis.asyncio as redis

from notification_manager import NotificationManager


REDIS_URL = "redis://localhost:6379/4"

CHANNEL = "notifications"


async def notification_listener(
    manager: NotificationManager,
):

    redis_client = redis.from_url(
        REDIS_URL,
        decode_responses=True,
    )

    pubsub = redis_client.pubsub()

    await pubsub.subscribe(CHANNEL)

    print("Notification listener started")

    try:

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

    finally:

        await pubsub.unsubscribe(CHANNEL)

        await pubsub.close()

        await redis_client.close()