from app.models import User, Workspace
from app.repo import fetch_workspace, resolve_owner


class WorkspaceNotFound(Exception):
    pass


def workspace_with_owner(workspace_id: int) -> tuple[Workspace, User | None]:
    workspace = fetch_workspace(workspace_id)
    if workspace is None:
        raise WorkspaceNotFound(workspace_id)
    return workspace, resolve_owner(workspace)


def is_owner(workspace_id: int, user_id: int) -> bool:
    workspace, owner = workspace_with_owner(workspace_id)
    return owner is not None and owner.id == user_id
