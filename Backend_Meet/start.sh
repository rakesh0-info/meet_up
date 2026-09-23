#!/usr/bin/env bash
# Start Celery worker in the background
celery -A celery_con.celery_config:celery_app worker --loglevel=info --pool=solo &

# Start your web application (replace with your actual web server command, e.g., gunicorn or uvicorn)
gunicorn myproject.wsgi:application --bind 0.0.0.0:$PORT