"""Session storage and lifetime checks."""

import time

from auth.tokens import expiry_status

SESSIONS = {}


def create_session(user_id, ttl=3600):
    token = f"{user_id}-{int(time.time())}"
    SESSIONS[token] = {"user_id": user_id, "issued_at": time.time(), "ttl": ttl}
    return token


def check_session(token, grace=30):
    session = SESSIONS.get(token)
    if session is None:
        return "expired"
    return expiry_status(session["issued_at"], session["ttl"], time.time(), grace)


def revoke_session(token):
    SESSIONS.pop(token, None)
