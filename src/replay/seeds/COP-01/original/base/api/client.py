import logging

BASE = "https://api.example.com"
log = logging.getLogger(__name__)


def fetch_user(session, user_id):
    url = BASE + "/users/" + user_id
    headers = auth_headers(session)
    response = session.get(url, headers=headers, timeout=5)
    if response.status_code == 404:
        log.warning("missing %s", user_id)
        return None
    response.raise_for_status()
    return response.json()
