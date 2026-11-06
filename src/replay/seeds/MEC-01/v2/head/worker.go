package queue

import (
	"context"
	"time"
)

type Handler func(ctx context.Context, j *Job) error

func Run(ctx context.Context, q *Queue, h Handler) {
	for {
		j, err := q.Pop()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		j.Attempts++
		if err := h(ctx, j); err != nil && shouldRetry(j) {
			time.Sleep(backoff(j))
			q.Push(j)
		}
	}
}
