from celery import Celery

celery_app = Celery(
    "meutub_tasks",
    broker="redis://localhost:6379/2",
    backend="redis://localhost:6379/2",
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