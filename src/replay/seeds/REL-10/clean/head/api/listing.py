"""Listing endpoints."""

from api.paging import page_bounds

ITEMS = []


def list_items(page=1, per_page=20):
    start, end = page_bounds(len(ITEMS), page, per_page)
    return ITEMS[start:end]


def add_item(item):
    ITEMS.append(item)
    return len(ITEMS)
