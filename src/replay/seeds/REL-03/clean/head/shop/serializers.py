from shop.models import Invoice
from shop.pricing import calculate_total


def serialize_invoice(invoice: Invoice) -> dict:
    return {
        "number": invoice.number,
        "item_count": len(invoice.items),
        "total_cents": calculate_total(invoice),
    }
