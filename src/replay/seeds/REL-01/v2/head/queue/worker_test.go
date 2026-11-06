package queue

import (
	"math/rand"
	"testing"
	"time"

	"example.com/jobs/backoff"
)

func TestNextDelayAddsJitter(t *testing.T) {
	jitter = func() float64 { return 0.5 }
	defer func() { jitter = rand.Float64 }()

	got := backoff.NextDelay(2)
	want := 800*time.Millisecond + 100*time.Millisecond
	if got != want {
		t.Fatalf("NextDelay(2) = %v, want %v", got, want)
	}
}
