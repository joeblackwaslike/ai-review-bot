package restock

import (
	"context"
	"log"
	"time"
)

type Job struct {
	OrderID  string
	Attempts int
}

type Worker struct {
	svc   *Service
	queue chan Job
}

func (w *Worker) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-w.queue:
			if err := w.svc.SendRestock(ctx, job.OrderID); err != nil {
				log.Printf("restock %s failed: %v", job.OrderID, err)
				w.retry(job)
			}
		}
	}
}

func (w *Worker) retry(job Job) {
	job.Attempts++
	if job.Attempts > 5 {
		return
	}
	time.AfterFunc(time.Duration(job.Attempts)*30*time.Second, func() {
		w.queue <- job
	})
}
