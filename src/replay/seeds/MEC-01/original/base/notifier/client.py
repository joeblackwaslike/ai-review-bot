import time
import requests
from notifier.config import load_settings


def post_event(url, payload, settings=None):
    settings = settings or load_settings()
    last_error = None
    for attempt in range(settings.max_retries):
        try:
            resp = requests.post(url, json=payload, timeout=settings.timeout_seconds, headers={'User-Agent': settings.user_agent})
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            last_error = exc
            time.sleep(settings.backoff_seconds * (attempt + 1))
    raise RuntimeError('delivery failed after %d attempts' % settings.max_retries) from last_error
