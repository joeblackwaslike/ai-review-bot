import logging

from jobs.handlers import PayloadHandler

log = logging.getLogger(__name__)


def run_job(job, payload):
    cleaned = PayloadHandler.normalize_payload(payload, strict=False)
    log.info("running %s", job.name)
    return job.execute(cleaned)
