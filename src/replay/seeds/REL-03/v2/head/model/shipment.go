package model

type Shipment struct {
	ID         string `json:"id"`
	OrderID    string `json:"order_id"`
	CarrierRef string `json:"carrier_ref"`
	Status     string `json:"status"`
}
