from decimal import ROUND_HALF_UP, Decimal

from shop.models import Invoice, LineItem


def line_cents(item: LineItem) -> int:
    return item.unit_cents * item.quantity


def compute_total(invoice: Invoice) -> int:
    subtotal = sum(line_cents(i) for i in invoice.items)
    tax = Decimal(subtotal) * Decimal(str(invoice.tax_rate))
    return subtotal + int(tax.quantize(Decimal(1), rounding=ROUND_HALF_UP))
