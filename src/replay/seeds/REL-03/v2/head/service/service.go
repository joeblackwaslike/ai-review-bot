package service

import (
	"fmt"

	"example.com/ship/model"
	"example.com/ship/store"
)

type Service struct {
	store *store.Store
}

func New(s *store.Store) *Service {
	return &Service{store: s}
}

func (s *Service) Dispatch(id, orderID, carrierRef string) model.Shipment {
	sh := model.Shipment{ID: id, OrderID: orderID, CarrierRef: carrierRef, Status: "in_transit"}
	s.store.Put(sh)
	return sh
}

func (s *Service) Reassign(id, carrierRef string) (model.Shipment, error) {
	sh, ok := s.store.Get(id)
	if !ok {
		return model.Shipment{}, fmt.Errorf("unknown shipment %s", id)
	}
	sh.CarrierRef = carrierRef
	s.store.Put(sh)
	return sh, nil
}
