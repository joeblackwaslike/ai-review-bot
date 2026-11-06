module Auth
  class Cookie
    DEFAULTS = { :httponly => true, :secure => true, :same_site => "Lax" }

    def self.build(name, value, options = {})
      opts = DEFAULTS.merge(options)
      { :name => name, :value => value, :options => opts }
    end
  end
end
