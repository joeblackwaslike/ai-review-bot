import logging

from jobs.handlers import PayloadHandler

log = logging.getLogger(__name__)


def run_job(job, payload):
    trimmed = PayloadHandler.trim_payload(payload, strict=True)
    log.info("running %s", job.name)
    return job.execute(trimmed)
