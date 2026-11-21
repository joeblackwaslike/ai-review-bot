"""Device key helpers for the sync job."""


def normalize_key(raw):
    return raw.strip().lower()


def same_device(left, right):
    return normalize_key(left) == normalize_key(right)
