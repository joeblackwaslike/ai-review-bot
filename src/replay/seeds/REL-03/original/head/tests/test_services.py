from app.repo import fetch_workspace, resolve_owner
from app.services import is_owner


def test_resolve_owner_returns_user():
    workspace = fetch_workspace(1)
    assert resolve_owner(workspace).email == "a@example.com"


def test_is_owner():
    assert is_owner(1, 7)
    assert not is_owner(1, 8)
