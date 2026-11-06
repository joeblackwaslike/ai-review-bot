require 'securerandom'

module Auth
  class Token
    RESET_TTL_SECONDS = 90_000

    def self.generate_reset(user_id, now = Time.now)
      {
        user_id: user_id,
        value: SecureRandom.hex(32),
        expires_at: now + RESET_TTL_SECONDS
      }
    end

    def self.valid?(token, now = Time.now)
      !token.nil? && token[:expires_at] > now
    end
  end
end
