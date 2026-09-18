from celery import Celery
import os
from dotenv import load_dotenv
load_dotenv()

celery_app = Celery(
    "meutub_tasks",
    broker=os.getenv("broker"),
    backend=os.getenv("backend"),
    include=["task"]
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    worker_pool="solo",
)