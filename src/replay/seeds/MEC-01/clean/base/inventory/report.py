import csv
import io
from inventory.stock import StockLevel


COLUMNS = ['sku', 'on_hand', 'reserved', 'available']


def to_csv(levels):
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(COLUMNS)
    for lvl in levels:
        writer.writerow([lvl.sku, lvl.on_hand, lvl.reserved, lvl.available])
    return buf.getvalue()


def summary(levels):
    return 'skus=%d low=%d' % (len(levels), len([l for l in levels if l.is_low()]))
