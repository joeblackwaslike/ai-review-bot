import logging

log = logging.getLogger(__name__)


def trim_payload(payload, strict=False):
    trimmed = {}
    for key, value in payload.items():
        name = key.strip().lower()
        if isinstance(value, str):
            value = value.strip()
        if value in (None, ""):
            if strict:
                raise ValueError("empty value for " + name)
            continue
        trimmed[name] = value
    return trimmed


def run_job(job, payload):
    trimmed = trim_payload(payload, strict=True)
    log.info("running %s", job.name)
    return job.execute(trimmed)
