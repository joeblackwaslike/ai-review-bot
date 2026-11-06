import time


def age(bucket):
    return time.monotonic() - bucket["updated"]
