from app.routes import get_workspace, get_workspace_owner


def test_get_workspace():
    status, body = get_workspace(1)
    assert status == 200
    assert body["owner_id"] == 7


def test_get_workspace_owner():
    assert get_workspace_owner(2) == (200, {"email": "b@example.com"})
