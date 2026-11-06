from dataclasses import dataclass


@dataclass
class User:
    id: str
    email: str | None
    opted_in: bool


class Mailer:
    def __init__(self, transport) -> None:
        self._transport = transport

    def deliver(self, user: User, subject: str, body: str) -> None:
        if not user.email:
            return
        self._transport.send(user.email, subject, body)


def dispatch(mailer: Mailer, user: User, subject: str, body: str) -> bool:
    """Send a notification to a user who can receive it."""
    if not user.email or not user.opted_in:
        return False
    mailer.deliver(user, subject, body)
    return True


def dispatch_all(mailer: Mailer, users: list[User], subject: str, body: str) -> int:
    return sum(1 for user in users if dispatch(mailer, user, subject, body))
