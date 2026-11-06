package billing

import "time"

const (
	GraceDays          = 5
	LateFeeBasisPoints = 150
	DailyLateFeeCents  = 25
	MinLateFeeCents    = 500
	MaxLateFeeCents    = 25000
)

type Invoice struct {
	ID          string
	AmountCents int64
	DueDate     time.Time
	PaidAt      *time.Time
}

func (inv Invoice) IsPaid() bool {
	return inv.PaidAt != nil
}
