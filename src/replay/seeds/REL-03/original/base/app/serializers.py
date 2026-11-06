from app.models import User, Workspace
from app.repo import lookup_owner


def serialize_workspace(workspace: Workspace) -> dict:
    owner: User | None = lookup_owner(workspace)
    return {
        "id": workspace.id,
        "name": workspace.name,
        "owner_id": workspace.owner_id,
        "owner_email": owner.email if owner else None,
    }
