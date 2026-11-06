import os
import json
from dataclasses import dataclass

DEFAULTS = {'timeout_seconds': 30, 'max_retries': 5, 'backoff_seconds': 2, 'user_agent': 'notifier/1.4'}


@dataclass
class Settings:
    timeout_seconds: int
    max_retries: int
    backoff_seconds: int
    user_agent: str


def load_settings(path=None):
    values = dict(DEFAULTS)
    if path and os.path.exists(path):
        with open(path) as fh:
            values.update(json.load(fh))
    return Settings(**values)
