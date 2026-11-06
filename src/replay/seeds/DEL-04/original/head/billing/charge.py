import logging

from billing.models import Invoice, InvoiceStatus, Payment

log = logging.getLogger(__name__)


class InvoiceAlreadyPaid(Exception):
    pass


class Charger:
    def __init__(self, gateway) -> None:
        self._gateway = gateway

    def charge(self, invoice: Invoice) -> Payment:
        """Charge the customer for an invoice and mark it paid."""
        self._gateway.charge(invoice.customer_id, invoice.total_cents)
        invoice.status = InvoiceStatus.PAID
        return Payment(invoice.id, invoice.total_cents)
