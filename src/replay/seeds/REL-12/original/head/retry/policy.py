"""Retry policy for outbound requests."""

import math
from retry.status import is_retryable

DEFAULT_ATTEMPTS = 3


def should_retry(status, attempt, max_attempts=DEFAULT_ATTEMPTS):
    return is_retryable(status) and attempt <= max_attempts


def backoff_seconds(attempt):
    return min(30, math.pow(2, attempt))
