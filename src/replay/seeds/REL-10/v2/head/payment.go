package billing

import "time"

func ApplyPayment(inv *Invoice, at time.Time) {
	if inv.PaidAt == nil {
		inv.PaidAt = &at
	}
}
