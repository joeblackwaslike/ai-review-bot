import logging

from notifier.client import post_event
from notifier.queue import EventQueue
from notifier.templates import render

log = logging.getLogger("notifier.worker")


def process(queue, endpoint, limit=50):
    sent, failed = 0, 0
    for event in queue.drain(limit):
        body = {
            "to": event["to"],
            "text": render(event["template"], **event["fields"]),
        }
        try:
            post_event(endpoint, body)
            sent += 1
        except RuntimeError:
            log.warning("dropping event for %s", event["to"])
            failed += 1
    return {"sent": sent, "failed": failed}
