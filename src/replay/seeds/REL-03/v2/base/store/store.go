package store

import (
	"sync"

	"example.com/ship/model"
)

type Store struct {
	mu   sync.Mutex
	rows map[string]model.Shipment
}

func New() *Store {
	return &Store{rows: map[string]model.Shipment{}}
}

func (s *Store) Put(sh model.Shipment) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows[sh.ID] = sh
}

func (s *Store) Get(id string) (model.Shipment, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sh, ok := s.rows[id]
	return sh, ok
}

func (s *Store) ByTracking(no string) (model.Shipment, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sh := range s.rows {
		if sh.TrackingNo == no {
			return sh, true
		}
	}
	return model.Shipment{}, false
}
