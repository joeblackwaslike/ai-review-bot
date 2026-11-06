from unittest import mock

from app.client import FlakyError, fetch_with_retry


def make_sender(failures):
    calls = []

    def send():
        calls.append(1)
        if len(calls) <= failures:
            raise FlakyError("temporary failure")
        return "ok"

    return send


def test_retries_then_succeeds():
    with mock.patch("app.util.backoff.time"):
        assert fetch_with_retry(make_sender(2)) == "ok"
