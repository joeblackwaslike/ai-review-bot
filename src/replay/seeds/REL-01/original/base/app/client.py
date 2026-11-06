from app.util.backoff import wait_before_retry


class FlakyError(Exception):
    pass


def fetch_with_retry(send, attempts=3):
    last_error = None
    for attempt in range(attempts):
        try:
            return send()
        except FlakyError as exc:
            last_error = exc
            wait_before_retry(attempt)
    raise last_error
