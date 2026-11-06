package backoff

import (
	"math/rand"
	"time"
)

var jitter = rand.Float64

func NextDelay(attempt int) time.Duration {
	base := 200 * time.Millisecond << uint(attempt)
	if base > 30*time.Second {
		base = 30 * time.Second
	}
	return base + time.Duration(jitter()*float64(base)/4)
}
