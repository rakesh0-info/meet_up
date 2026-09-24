import ssl

from celery import Celery
import os
from dotenv import load_dotenv
load_dotenv()

celery_app = Celery(
    "meet_up_tasks",
    broker=os.getenv("broker"),
    backend=os.getenv("backend"),
    include=["task"]
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Kolkata", 
    enable_utc=True,
    worker_pool="solo",
    broker_transport_options={
        'ssl': {
            'ssl_cert_reqs': ssl.CERT_NONE
        }
    },
    redis_backend_use_ssl={
        'ssl_cert_reqs': ssl.CERT_NONE
    }
    
)