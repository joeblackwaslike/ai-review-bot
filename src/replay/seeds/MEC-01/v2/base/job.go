package queue

import "time"

type Job struct {
	ID string
	Payload []byte
	Attempts int
	EnqueuedAt time.Time
}

func NewJob(id string,payload []byte) *Job {
	return &Job{ID:id,Payload:payload,EnqueuedAt:time.Now()}
}
