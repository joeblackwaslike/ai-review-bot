"""Listing endpoints."""

ITEMS = []


def page_bounds(total, page, per_page, max_per_page=100):
    """Return the (start, end) slice for a 1-based page of results.

    Pages past the end return an empty slice at the end of the data.
    """
    if page < 1:
        raise ValueError("page must be at least 1")
    if per_page < 1:
        raise ValueError("per_page must be at least 1")
    if total < 0:
        raise ValueError("total must not be negative")
    per_page = min(per_page, max_per_page)
    start = (page - 1) * per_page
    if start >= total:
        return total, total
    end = start + per_page
    if end > total:
        end = total
    return start, end


def list_items(page=1, per_page=20):
    start, end = page_bounds(len(ITEMS), page, per_page)
    return ITEMS[start:end]


def add_item(item):
    ITEMS.append(item)
    return len(ITEMS)
