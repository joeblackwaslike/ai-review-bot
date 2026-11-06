from app.models import User, Workspace
from app.repo import resolve_owner


def serialize_workspace(workspace: Workspace) -> dict:
    owner: User | None = resolve_owner(workspace)
    return {
        "id": workspace.id,
        "name": workspace.name,
        "account_id": workspace.owner_id,
        "owner_email": owner.email if owner else None,
    }
