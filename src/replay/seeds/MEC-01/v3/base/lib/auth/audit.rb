module Auth
  class Audit
    def self.record(user_id, event, meta = {})
      entry = { :user_id => user_id, :event => event, :meta => meta, :at => Time.now.utc }
      entries << entry
      entry
    end

    def self.entries
      @entries ||= []
    end
  end
end
