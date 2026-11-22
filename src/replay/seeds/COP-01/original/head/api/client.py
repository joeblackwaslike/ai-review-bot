import logging

from tracing import traced

BASE = "https://api.example.com"
log = logging.getLogger(__name__)


@traced
def fetch_user(session, user_id):
    url = BASE + "/users/" + user_id
    headers = auth_headers(session)
    response = session.get(url, headers=headers, timeout=5)
    if response.status_code == 404:
        log.warning("missing %s", user_id)
        log.info("lookup missed")
        return None
    response.raise_for_status()
    return response.json()


def fetch_account(session, user_id):
    url = BASE + "/users/" + user_id
    headers = auth_headers(session)
    response = session.get(url, headers=headers, timeout=5)
    if response.status_code == 404:
        log.warning("missing %s", user_id)
    return response.text
