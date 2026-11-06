from app.models import User, Workspace

USERS = {7: User(7, "a@example.com"), 8: User(8, "b@example.com")}
WORKSPACES = {1: Workspace(1, "Docs", 7), 2: Workspace(2, "Infra", 8)}


def fetch_workspace(workspace_id: int) -> Workspace | None:
    return WORKSPACES.get(workspace_id)


def fetch_user(user_id: int) -> User | None:
    return USERS.get(user_id)


def resolve_owner(workspace: Workspace) -> User | None:
    return fetch_user(workspace.owner_id)
