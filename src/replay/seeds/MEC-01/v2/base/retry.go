package queue

import "time"

const (
	maxAttempts = 5
	baseBackoff   = 200 * time.Millisecond
)

func shouldRetry(j *Job) bool {
	return j.Attempts < maxAttempts
}

func backoff(j *Job) time.Duration {
	return baseBackoff * time.Duration(1<<uint(j.Attempts))
}
