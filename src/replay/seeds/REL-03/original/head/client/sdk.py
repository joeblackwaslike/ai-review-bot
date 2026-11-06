import json
from urllib.request import urlopen


def get_workspace(base_url: str, workspace_id: int) -> dict:
    with urlopen(f"{base_url}/workspaces/{workspace_id}") as resp:
        data = json.load(resp)
    return {"id": data["id"], "name": data["name"], "owner": data["owner_id"]}
