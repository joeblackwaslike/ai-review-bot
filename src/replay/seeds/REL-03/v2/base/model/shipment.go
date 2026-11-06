package model

type Shipment struct {
	ID         string `json:"id"`
	OrderID    string `json:"order_id"`
	TrackingNo string `json:"tracking_no"`
	Status     string `json:"status"`
}
