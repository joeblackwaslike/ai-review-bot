class PickList
  Line = Struct.new(:sku, :quantity)

  def self.build(items)
    new(items.map { |item| Line.new(item.sku, item.quantity) })
  end

  attr_reader :lines

  def initialize(lines)
    @lines = lines
  end

  def total_units
    lines.sum(&:quantity)
  end
end
