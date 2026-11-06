require_relative "formatting"

module Shop
  class Receipt
    def initialize(items)
      @items = items
    end

    def summary
      total = @items.sum { |item| item[:cents] }
      "#{Formatting.pluralize(@items.size, 'item')}: #{Formatting.money(total)}"
    end
  end
end
