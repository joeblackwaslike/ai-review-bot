import logging

log = logging.getLogger(__name__)
LIMIT = 500


def checkout(cart):
    amount = total_price(cart.items, cart.rate)
    return {"amount": amount}


def total_price(items, rate):
    subtotal = 0
    for item in items:
        subtotal += item.price * item.qty
    discount = subtotal * rate
    if discount > LIMIT:
        discount = LIMIT
    log.info("discount %s", discount)
    return subtotal - discount
