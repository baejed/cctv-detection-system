import os
from slowapi import Limiter
from starlette.requests import Request

_redis_url = os.getenv("REDIS_URL", "")
_storage = f"redis://{_redis_url.split('://')[-1]}" if _redis_url else "memory://"

# When TRUST_PROXY_HEADERS=true the first value in X-Forwarded-For is used as
# the client IP so rate limits apply per real client instead of per proxy IP.
_TRUST_PROXY = os.getenv("TRUST_PROXY_HEADERS", "false").lower() == "true"


def _get_client_ip(request: Request) -> str:
    if _TRUST_PROXY:
        forwarded_for = request.headers.get("x-forwarded-for", "")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


limiter = Limiter(key_func=_get_client_ip, storage_uri=_storage)
