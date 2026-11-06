from unittest import mock

from gateway.handler import allow_request


def make_bucket(tokens):
    return {"tokens": tokens, "capacity": 10, "updated": 100.0}


def test_allows_when_tokens_available():
    with mock.patch("gateway.handler.time") as fake_time:
        fake_time.monotonic.return_value = 100.0
        assert allow_request(make_bucket(3)) is True


def test_rejects_when_empty():
    with mock.patch("gateway.handler.time") as fake_time:
        fake_time.monotonic.return_value = 100.0
        assert allow_request(make_bucket(0)) is False


def test_refill_restores_tokens():
    bucket = make_bucket(0)
    with mock.patch("gateway.handler.time") as fake_time:
        fake_time.monotonic.return_value = 101.0
        assert allow_request(bucket) is True
