FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

WORKDIR /app
COPY homestro-marketing-pilot/adtech_pilot/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY homestro-marketing-pilot/adtech_pilot/ /app/adtech_pilot/

CMD ["python", "-m", "adtech_pilot.frankenstein_core", "--once"]
