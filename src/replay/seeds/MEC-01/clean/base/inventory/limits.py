import os

LIMITS = {'low_stock': 10, 'reorder_qty': 250, 'max_per_order': 40, 'hold_hours': 48, 'region': 'us-east'}


def get_limit(name):
    override = os.environ.get('INV_' + name.upper())
    if override is not None:
        return int(override)
    return LIMITS[name]
