import json
from inventory.stock import StockLevel


def load_levels(path):
    with open(path) as fh:
        rows = json.load(fh)
    return [StockLevel(r['sku'], on_hand = r.get('on_hand', 0), reserved = r.get('reserved', 0)) for r in rows]


def save_levels(path, levels):
    rows = [{'sku': l.sku, 'on_hand': l.on_hand, 'reserved': l.reserved} for l in levels]
    with open(path, 'w') as fh:
        json.dump(rows, fh, indent = 2)
