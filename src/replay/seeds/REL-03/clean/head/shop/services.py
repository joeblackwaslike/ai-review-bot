from shop.models import Invoice
from shop.pricing import calculate_total

PAYMENT_LIMIT_CENTS = 500_000


def can_pay_online(invoice: Invoice) -> bool:
    return 0 < calculate_total(invoice) <= PAYMENT_LIMIT_CENTS


def amount_due(invoice: Invoice, paid_cents: int) -> int:
    return max(calculate_total(invoice) - paid_cents, 0)
