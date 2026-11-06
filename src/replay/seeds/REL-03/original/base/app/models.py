from dataclasses import dataclass


@dataclass
class Workspace:
    id: int
    name: str
    owner_id: int


@dataclass
class User:
    id: int
    email: str
