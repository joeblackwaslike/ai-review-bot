require "digest"

module Auth
  class Password
    MIN_LENGTH = 12

    def self.valid?(candidate)
      candidate.is_a?(String) && candidate.length >= MIN_LENGTH && candidate =~ /\d/ && candidate =~ /[A-Z]/
    end

    def self.digest(candidate, salt)
      Digest::SHA256.hexdigest("#{salt}:#{candidate}")
    end
  end
end
