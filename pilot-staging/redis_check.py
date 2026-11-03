import os
import sys
from uuid import uuid4

import redis


def main() -> int:
    redis_url = os.environ.get("REDIS_URL")
    if not redis_url:
        print("ERROR: REDIS_URL is missing.")
        return 1

    client = redis.Redis.from_url(
        redis_url,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
    )

    try:
        client.ping()
        key = f"pilot_staging:connection_check:{uuid4()}"
        client.set(key, "ok", ex=30)
        value = client.get(key)
        client.delete(key)

        if value != "ok":
            print("ERROR: Redis PING succeeded, but the write/read check failed.")
            return 1

        print("OK: Railway Redis responds; write/read check succeeded.")
        return 0
    except redis.RedisError as exc:
        # Never print REDIS_URL: it can contain credentials.
        print(f"Redis connection error: {type(exc).__name__}")
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
