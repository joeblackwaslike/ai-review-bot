class RetryScheduler
  MAX_ATTEMPTS = 6

  def initialize(queue)
    @queue = queue
  end

  def run(job_class, *args, attempt: 1)
    job_class.new.perform(*args)
  rescue StandardError => e
    Rails.logger.warn("#{job_class} failed (attempt #{attempt}): #{e.message}")
    raise if attempt >= MAX_ATTEMPTS

    @queue.enqueue_in(2**attempt * 60, job_class, *args, attempt: attempt + 1)
  end
end
