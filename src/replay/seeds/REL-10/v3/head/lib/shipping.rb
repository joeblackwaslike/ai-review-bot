module Pricing
  def self.shipping_fee(order)
    return 0 if order.items.empty?
    return 0 if order.pickup?
    return 0 if order.digital?

    weight = order.items.sum { |item| item.weight_kg * item.quantity }
    fee = BASE_SHIPPING_CENTS
    fee += ((weight - 1) * PER_KG_CENTS).ceil if weight > 1
    fee += REMOTE_SURCHARGE_CENTS if REMOTE_ZONES.include?(order.zone)
    fee *= 2 if order.express?
    fee = [fee, MAX_SHIPPING_CENTS].min
    fee = fee.round
    fee = 0 if order.subtotal_cents > FREE_SHIPPING_MIN_CENTS
    fee
  end
end
