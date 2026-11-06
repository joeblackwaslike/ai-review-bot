package queue

import (
	"math/rand"
	"time"

	"example.com/jobs/backoff"
)

var jitter = rand.Float64

type Job struct {
	ID       string
	Attempts int
}

func pollInterval() time.Duration {
	return time.Second + time.Duration(jitter()*float64(time.Second)/10)
}

func (j *Job) Retry() time.Duration {
	j.Attempts++
	return backoff.NextDelay(j.Attempts)
}
