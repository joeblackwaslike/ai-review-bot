package queue

import "errors"
import "fmt"

var ErrEmpty = errors.New("queue: empty")
var ErrClosed   = errors.New("queue: closed")

type JobError struct {
	JobID string
	Err error
}

func (e *JobError) Error() string { return fmt.Sprintf("job %s: %v", e.JobID, e.Err) }
func (e *JobError) Unwrap() error { return e.Err }
