from dataclasses import dataclass
from enum import Enum


class InvoiceStatus(Enum):
    OPEN = "open"
    PAID = "paid"


@dataclass
class Invoice:
    id: str
    customer_id: str
    total_cents: int
    status: InvoiceStatus = InvoiceStatus.OPEN


@dataclass
class Payment:
    invoice_id: str
    amount_cents: int
    skipped: bool = False

    @classmethod
    def skip(cls, invoice_id: str) -> "Payment":
        return cls(invoice_id, 0, skipped=True)
