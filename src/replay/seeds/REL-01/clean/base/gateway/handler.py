from gateway.bucket import refill

RATE = 5.0


def allow_request(bucket, cost=1):
    refill(bucket, RATE)
    if bucket["tokens"] < cost:
        return False
    bucket["tokens"] -= cost
    return True
