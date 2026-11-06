from shop.models import Invoice, LineItem
from shop.pricing import calculate_total


def test_calculate_total_applies_tax():
    invoice = Invoice("X", [LineItem("a", 1000, 2)], 0.1)
    assert calculate_total(invoice) == 2200


def test_calculate_total_empty():
    assert calculate_total(Invoice("X")) == 0
