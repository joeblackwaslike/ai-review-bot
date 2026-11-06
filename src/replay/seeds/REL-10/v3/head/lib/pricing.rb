module Pricing
  BASE_SHIPPING_CENTS = 499
  PER_KG_CENTS = 120
  REMOTE_SURCHARGE_CENTS = 800
  MAX_SHIPPING_CENTS = 4500
  FREE_SHIPPING_MIN_CENTS = 7500
  REMOTE_ZONES = %w[AK HI PR].freeze

  def self.subtotal_cents(order)
    order.items.sum { |item| item.price_cents * item.quantity }
  end
end
