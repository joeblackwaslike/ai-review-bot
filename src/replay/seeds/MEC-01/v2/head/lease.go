package queue

import "time"

type Lease struct {
	JobID   string
	Expires time.Time
}

func NewLease(id string, ttl time.Duration) Lease {
	return Lease{JobID: id, Expires: time.Now().Add(ttl)}
}

func (l Lease) Expired() bool { return time.Now().After(l.Expires) }
