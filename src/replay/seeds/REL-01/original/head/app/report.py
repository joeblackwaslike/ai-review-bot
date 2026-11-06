from app.util.backoff import elapsed_since


def format_duration(start):
    return f"{elapsed_since(start):.1f}s"
