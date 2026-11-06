from inventory.limits import get_limit
from inventory.stock import StockLevel


def reorder_list(levels):
    orders = []
    for level in sorted(levels, key=lambda l: l.sku):
        if level.is_low():
            orders.append(
                {
                    "sku": level.sku,
                    "qty": get_limit("reorder_qty"),
                    "region": "us-east",
                }
            )
    return orders


def total_units(orders):
    return sum(o["qty"] for o in orders)
