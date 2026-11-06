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

func LateFee(inv Invoice, today time.Time) int64 {
	if inv.PaidAt != nil {
		return 0
	}
	daysLate := int(today.Sub(inv.DueDate).Hours() / 24)
	if daysLate <= GraceDays {
		return 0
	}
	fee := inv.AmountCents * LateFeeBasisPoints / 10000
	chargeable := daysLate - GraceDays
	fee += int64(chargeable) * DailyLateFeeCents
	if fee < MinLateFeeCents {
		fee = MinLateFeeCents
	}
	if fee > MaxLateFeeCents {
		fee = MaxLateFeeCents
	}
	if fee > inv.AmountCents {
		fee = inv.AmountCents
	}
	return fee
}
