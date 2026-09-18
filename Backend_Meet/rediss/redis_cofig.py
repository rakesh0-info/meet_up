import os
from dotenv import load_dotenv
from redis.asyncio import Redis

load_dotenv()

REDIS_URL = os.getenv("REDIS_URL")
if not REDIS_URL:
    redis_host = os.getenv("REDIS_HOST", "localhost")
    redis_port = os.getenv("REDIS_PORT", "6379")
    redis_db = os.getenv("REDIS_DB", "4")
    REDIS_URL = f"redis://{redis_host}:{redis_port}/{redis_db}"

redis_client = Redis.from_url(
    REDIS_URL,
    decode_responses=True
)

