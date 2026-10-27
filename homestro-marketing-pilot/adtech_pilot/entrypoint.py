from __future__ import annotations

import os
from pathlib import Path

PILOT_UID = 10001
PILOT_GID = 10001
WRITABLE_DIRECTORIES = (
    Path("/data/adtech-pilot"),
    Path("/data/adtech-creatives"),
)

if os.geteuid() == 0:
    for directory in WRITABLE_DIRECTORIES:
        directory.mkdir(parents=True, exist_ok=True)
        os.chown(directory, PILOT_UID, PILOT_GID)
    os.setgroups([])
    os.setgid(PILOT_GID)
    os.setuid(PILOT_UID)

os.execv(
    "/opt/venv/bin/uvicorn",
    [
        "uvicorn",
        "adtech_pilot.main_pilot:app",
        "--host",
        "0.0.0.0",
        "--port",
        "8080",
        "--proxy-headers",
    ],
)
