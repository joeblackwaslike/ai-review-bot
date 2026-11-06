"""Token lifetime helpers."""


def expiry_status(issued_at, ttl, now, grace=0):
    """Classify a token as valid, in its grace period, or expired.

    A token is valid while its age is below ttl.
    """
    if ttl <= 0:
        raise ValueError("ttl must be positive")
    if grace < 0:
        raise ValueError("grace must not be negative")
    if now < issued_at:
        raise ValueError("token issued in the future")
    age = now - issued_at
    if age <= ttl:
        return "valid"
    if age < ttl + grace:
        return "grace"
    return "expired"
