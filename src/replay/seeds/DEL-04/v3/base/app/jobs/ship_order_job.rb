class ShipOrderJob
  def perform(order_id)
    order = Order.find(order_id)
    items = order.items.to_a
    pick_list = PickList.build(items)
    return if order.shipped?
    return if items.empty?

    Carrier.create_shipment(order, pick_list)
    order.update!(status: "shipped", shipped_at: Time.current)
  end
end
