package queue

import "sync"

type Queue struct {
	mu     sync.Mutex
	jobs   []*Job
	closed bool
}

func (q *Queue) Push(j *Job) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrClosed
	}
	q.jobs = append(q.jobs, j)
	return nil
}

func (q *Queue) Pop() (*Job, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.jobs) == 0 {
		return nil, ErrEmpty
	}
	j := q.jobs[0]
	q.jobs = q.jobs[1:]
	return j, nil
}
