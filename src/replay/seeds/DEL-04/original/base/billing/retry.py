import logging

from billing.charge import Charger
from billing.models import Invoice, Payment

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 3


def charge_with_retry(charger: Charger, invoice: Invoice, notify) -> Payment:
    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            payment = charger.charge(invoice)
            notify(invoice, payment)
            return payment
        except Exception as exc:
            last_error = exc
            log.warning("charge attempt %d failed for %s: %s", attempt, invoice.id, exc)
    raise RuntimeError(f"charge failed for {invoice.id}") from last_error
