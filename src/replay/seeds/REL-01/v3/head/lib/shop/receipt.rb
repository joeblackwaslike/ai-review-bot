require_relative "formatting"
require_relative "currency"

module Shop
  class Receipt
    def initialize(items)
      @items = items
    end

    def summary
      total = @items.sum { |item| item[:cents] }
      "#{Formatting.pluralize(@items.size, 'item')}: #{Currency.money(total)}"
    end
  end
end
