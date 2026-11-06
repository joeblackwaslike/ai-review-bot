module Auth
  class Session
    IDLE_TIMEOUT = 1800

    attr_reader :user_id, :touched_at

    def initialize(user_id, now = Time.now)
      @user_id = user_id
      @touched_at = now
    end

    def expired?(now = Time.now)
      now - @touched_at > IDLE_TIMEOUT
    end

    def touch(now = Time.now)
      @touched_at = now
    end
  end
end
