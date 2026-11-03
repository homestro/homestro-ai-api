import os

from celery import Celery
from celery.schedules import crontab

redis_url = os.environ.get("REDIS_URL")
if not redis_url:
    raise RuntimeError("Chybí Railway proměnná REDIS_URL.")

app = Celery(
    "homestro_pilot",
    broker=redis_url,
    backend=redis_url,
    include=[
        "tasks",
        "agents.kreativni_agent",
        "agents.product_hunter_agent",
    ],
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
    beat_schedule={
        "product-hunter-daily-scan": {
            "task": "product_hunter.scan_shopify_catalog",
            # 06:15 UTC daily (07:15 in Germany during CET).
            "schedule": crontab(hour=6, minute=15),
        },
    },
)
