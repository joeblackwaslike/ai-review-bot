package restock

import (
	"context"
	"time"
)

type Order struct {
	ID         string
	SupplierID string
	SKU        string
	Quantity   int
	SentAt     *time.Time
}

type Store interface {
	Load(ctx context.Context, id string) (*Order, error)
	MarkSent(ctx context.Context, id string, at time.Time) error
}

type Mailer interface {
	Send(ctx context.Context, supplierID, subject, body string) error
}
