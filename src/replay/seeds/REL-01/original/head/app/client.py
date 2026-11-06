import time

MAX_DELAY = 8.0


class FlakyError(Exception):
    pass


def wait_before_retry(attempt, base=0.25):
    delay = min(base * (2 ** attempt), MAX_DELAY)
    time.sleep(delay)
    return delay


def fetch_with_retry(send, attempts=3):
    last_error = None
    for attempt in range(attempts):
        try:
            return send()
        except FlakyError as exc:
            last_error = exc
            wait_before_retry(attempt)
    raise last_error
