def is_retryable(status):
    return status >= 500 and status != 501
