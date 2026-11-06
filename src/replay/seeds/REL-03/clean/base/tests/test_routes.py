from shop.routes import get_invoice, get_invoice_total


def test_get_invoice():
    status, body = get_invoice("INV-1")
    assert status == 200
    assert body["total_cents"] == 1650


def test_get_invoice_total():
    assert get_invoice_total("INV-1") == (200, {"cents": 1650})
