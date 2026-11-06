module Shop
  module Formatting
    def self.pluralize(count, word)
      count == 1 ? "#{count} #{word}" : "#{count} #{word}s"
    end

    def self.money(cents)
      format("$%d.%02d", cents / 100, cents % 100)
    end
  end
end
