import os

from celery import Celery

redis_url = os.environ.get("REDIS_URL")
if not redis_url:
    raise RuntimeError("Missing Railway environment variable REDIS_URL.")

app = Celery(
    "homestro_pilot",
    broker=redis_url,
    backend=redis_url,
)

app.conf.update(
    accept_content=["json"],
    task_serializer="json",
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    broker_connection_retry_on_startup=True,
    broker_transport_options={"global_keyprefix": "pilot_staging:"},
    result_backend_transport_options={"global_keyprefix": "pilot_staging:"},
)
