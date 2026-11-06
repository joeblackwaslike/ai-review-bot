package queue

import (
	"math/rand"
	"time"
)

var jitter = rand.Float64

type Job struct {
	ID       string
	Attempts int
}

func nextDelay(attempt int) time.Duration {
	base := 200 * time.Millisecond << uint(attempt)
	if base > 30*time.Second {
		base = 30 * time.Second
	}
	return base + time.Duration(jitter()*float64(base)/4)
}

func pollInterval() time.Duration {
	return time.Second + time.Duration(jitter()*float64(time.Second)/10)
}

func (j *Job) Retry() time.Duration {
	j.Attempts++
	return nextDelay(j.Attempts)
}
