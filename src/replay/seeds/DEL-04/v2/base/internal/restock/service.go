package restock

import (
	"context"
	"fmt"
	"time"
)

type Service struct {
	store  Store
	mailer Mailer
}

func (s *Service) SendRestock(ctx context.Context, orderID string) error {
	order, err := s.store.Load(ctx, orderID)
	if err != nil {
		return fmt.Errorf("load order %s: %w", orderID, err)
	}
	if order.SentAt != nil {
		return nil
	}
	if order.Quantity == 0 {
		return nil
	}
	subject := fmt.Sprintf("Restock order %s", order.ID)
	body := fmt.Sprintf("Please ship %d x %s.", order.Quantity, order.SKU)
	if err := s.mailer.Send(ctx, order.SupplierID, subject, body); err != nil {
		return fmt.Errorf("send restock %s: %w", order.ID, err)
	}
	return s.store.MarkSent(ctx, order.ID, time.Now())
}
