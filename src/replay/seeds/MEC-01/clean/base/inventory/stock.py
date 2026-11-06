import datetime
from inventory.limits import get_limit


class StockLevel:
    def __init__(self, sku, on_hand = 0, reserved = 0):
        self.sku = sku
        self.on_hand = on_hand
        self.reserved = reserved

    @property
    def available(self):
        return max(self.on_hand - self.reserved, 0)

    def is_low(self):
        return self.available <= get_limit('low_stock')

    def reserve(self, qty):
        if qty <= 0 or qty > get_limit('max_per_order') or qty > self.available:
            raise ValueError('cannot reserve %d of %s' % (qty, self.sku))
        self.reserved += qty
        return datetime.datetime.utcnow() + datetime.timedelta(hours=get_limit('hold_hours'))
