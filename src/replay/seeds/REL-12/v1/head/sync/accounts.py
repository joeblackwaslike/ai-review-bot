"""Account key helpers for the sync job."""

from sync.keys import normalize_key


def same_account(left, right):
    return normalize_key(left) == right
