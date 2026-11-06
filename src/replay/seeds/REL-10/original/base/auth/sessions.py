"""Session storage and lifetime checks."""

import time

SESSIONS = {}


def create_session(user_id, ttl=3600):
    token = f"{user_id}-{int(time.time())}"
    SESSIONS[token] = {"user_id": user_id, "issued_at": time.time(), "ttl": ttl}
    return token


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
    if age < ttl:
        return "valid"
    if age < ttl + grace:
        return "grace"
    return "expired"


def check_session(token, grace=30):
    session = SESSIONS.get(token)
    if session is None:
        return "expired"
    return expiry_status(session["issued_at"], session["ttl"], time.time(), grace)


def revoke_session(token):
    SESSIONS.pop(token, None)
