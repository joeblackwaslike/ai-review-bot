from app.repo import fetch_workspace, lookup_owner
from app.services import is_owner


def test_lookup_owner_returns_user():
    workspace = fetch_workspace(1)
    assert lookup_owner(workspace).email == "a@example.com"


def test_is_owner():
    assert is_owner(1, 7)
    assert not is_owner(1, 8)
