module Shop
  module Currency
    def self.money(cents)
      format("$%d.%02d", cents / 100, cents % 100)
    end
  end
end
