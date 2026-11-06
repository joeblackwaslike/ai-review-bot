from shop.models import Invoice, LineItem
from shop.pricing import calculate_total
from shop.serializers import serialize_invoice

INVOICES = {
    "INV-1": Invoice("INV-1", [LineItem("pen", 150, 4), LineItem("ink", 900, 1)], 0.1),
}


def get_invoice(number: str) -> tuple[int, dict]:
    invoice = INVOICES.get(number)
    if invoice is None:
        return 404, {"error": "not found"}
    return 200, serialize_invoice(invoice)


def get_invoice_total(number: str) -> tuple[int, dict]:
    invoice = INVOICES.get(number)
    if invoice is None:
        return 404, {"error": "not found"}
    return 200, {"cents": calculate_total(invoice)}
