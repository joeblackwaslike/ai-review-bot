from shop.models import Invoice
from shop.pricing import compute_total


def serialize_invoice(invoice: Invoice) -> dict:
    return {
        "number": invoice.number,
        "item_count": len(invoice.items),
        "total_cents": compute_total(invoice),
    }
