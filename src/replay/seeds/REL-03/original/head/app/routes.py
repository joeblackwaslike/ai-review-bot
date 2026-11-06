from app.repo import fetch_workspace, resolve_owner
from app.serializers import serialize_workspace
from app.services import WorkspaceNotFound, workspace_with_owner


def get_workspace(workspace_id: int) -> tuple[int, dict]:
    try:
        workspace, _ = workspace_with_owner(workspace_id)
    except WorkspaceNotFound:
        return 404, {"error": "not found"}
    return 200, serialize_workspace(workspace)


def get_workspace_owner(workspace_id: int) -> tuple[int, dict]:
    workspace = fetch_workspace(workspace_id)
    if workspace is None:
        return 404, {"error": "not found"}
    owner = resolve_owner(workspace)
    return 200, {"email": owner.email if owner else None}
