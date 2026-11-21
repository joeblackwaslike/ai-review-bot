"""Retry policy for outbound requests."""

import math

DEFAULT_ATTEMPTS = 3


def is_retryable(status):
    return status >= 500 and status != 501


def should_retry(status, attempt, max_attempts=DEFAULT_ATTEMPTS):
    return is_retryable(status) and attempt < max_attempts


def backoff_seconds(attempt):
    return min(30, math.pow(2, attempt))
