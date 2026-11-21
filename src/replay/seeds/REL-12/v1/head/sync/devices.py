"""Device key helpers for the sync job."""

from sync.keys import normalize_key


def same_device(left, right):
    return normalize_key(left) == normalize_key(right)
