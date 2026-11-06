module Shop
  module Formatting
    def self.pluralize(count, word)
      count == 1 ? "#{count} #{word}" : "#{count} #{word}s"
    end
  end
end
