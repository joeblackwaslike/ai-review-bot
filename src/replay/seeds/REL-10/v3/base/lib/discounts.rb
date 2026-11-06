module Discounts
  def self.apply(subtotal_cents, code)
    return subtotal_cents unless code == "WELCOME10"

    subtotal_cents - (subtotal_cents * 0.1).round
  end
end
