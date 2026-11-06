package billing

import "time"

func LateFee(inv Invoice, today time.Time) int64 {
	if inv.PaidAt != nil {
		return 0
	}
	daysLate := int(today.Sub(inv.DueDate).Hours() / 24)
	if daysLate < GraceDays {
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
