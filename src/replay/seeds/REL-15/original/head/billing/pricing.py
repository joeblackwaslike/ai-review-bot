import logging


class Pricer:
    log = logging.getLogger(__name__)
    LIMIT = 500

    def compute_total(self, items, rate, currency="USD"):
        subtotal = 0
        for item in items:
            subtotal += item.price * item.qty
        discount = subtotal * rate
        if discount > self.LIMIT:
            discount = self.LIMIT
        self.log.info("discount %s", discount)
        return subtotal - discount


def checkout(cart):
    amount = Pricer().compute_total(cart.items, cart.tax_rate)
    return {"amount": amount}
