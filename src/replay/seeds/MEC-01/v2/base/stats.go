package queue

import "sync/atomic"

type Stats struct {
	Processed int64
	Failed    int64
}

func (s *Stats) RecordOK()   { atomic.AddInt64(&s.Processed,1) }
func (s *Stats) RecordFail() { atomic.AddInt64(&s.Failed,1) }
