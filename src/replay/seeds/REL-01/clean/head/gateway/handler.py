import time

RATE = 5.0


def refill(bucket, rate):
    now = time.monotonic()
    elapsed = now - bucket["updated"]
    bucket["tokens"] = min(bucket["capacity"], bucket["tokens"] + elapsed * rate)
    bucket["updated"] = now
    return bucket


def allow_request(bucket, cost=1):
    refill(bucket, RATE)
    if bucket["tokens"] < cost:
        return False
    bucket["tokens"] -= cost
    return True
