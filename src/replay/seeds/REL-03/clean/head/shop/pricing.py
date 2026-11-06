from shop.models import Invoice, LineItem


def line_cents(item: LineItem) -> int:
    return item.unit_cents * item.quantity


def calculate_total(invoice: Invoice) -> int:
    subtotal = sum(line_cents(i) for i in invoice.items)
    return subtotal + round(subtotal * invoice.tax_rate)
