module Auth
  class Throttle
    MAX_ATTEMPTS = 5
    WINDOW = 300

    def initialize
      @attempts = Hash.new { |h, k| h[k] = [] }
    end

    def allow?(key, now = Time.now)
      recent = @attempts[key].select { |t| now - t < WINDOW }
      @attempts[key] = recent
      recent.size < MAX_ATTEMPTS
    end

    def record(key, now = Time.now)
      @attempts[key] << now
    end
  end
end
