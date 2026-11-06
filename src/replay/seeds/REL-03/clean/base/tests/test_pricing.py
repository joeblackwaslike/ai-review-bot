from shop.models import Invoice, LineItem
from shop.pricing import compute_total


def test_compute_total_applies_tax():
    invoice = Invoice("X", [LineItem("a", 1000, 2)], 0.1)
    assert compute_total(invoice) == 2200


def test_compute_total_empty():
    assert compute_total(Invoice("X")) == 0
