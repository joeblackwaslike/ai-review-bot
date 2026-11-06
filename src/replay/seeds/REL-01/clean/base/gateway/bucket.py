import time


def refill(bucket, rate):
    now = time.monotonic()
    elapsed = now - bucket["updated"]
    bucket["tokens"] = min(bucket["capacity"], bucket["tokens"] + elapsed * rate)
    bucket["updated"] = now
    return bucket


def age(bucket):
    return time.monotonic() - bucket["updated"]
