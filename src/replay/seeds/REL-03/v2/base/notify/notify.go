package notify

import (
	"fmt"

	"example.com/ship/model"
)

func Subject(sh model.Shipment) string {
	return fmt.Sprintf("Order %s shipped, tracking %s", sh.OrderID, sh.TrackingNo)
}
