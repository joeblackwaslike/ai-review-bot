import time

MAX_DELAY = 8.0


def wait_before_retry(attempt, base=0.25):
    delay = min(base * (2 ** attempt), MAX_DELAY)
    time.sleep(delay)
    return delay


def elapsed_since(start):
    return time.monotonic() - start
