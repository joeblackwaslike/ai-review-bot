package handler

import (
	"encoding/json"
	"net/http"

	"example.com/ship/service"
)

type Handler struct {
	svc *service.Service
}

func New(svc *service.Service) *Handler {
	return &Handler{svc: svc}
}

func (h *Handler) Dispatch(w http.ResponseWriter, r *http.Request) {
	sh := h.svc.Dispatch(r.URL.Query().Get("id"), r.URL.Query().Get("order"), r.URL.Query().Get("tracking"))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sh)
}
