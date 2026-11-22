"""Account key helpers for the sync job."""


def normalize_key(raw):
    return raw.strip().lower()


def same_account(left, right):
    return normalize_key(left) == normalize_key(right)
