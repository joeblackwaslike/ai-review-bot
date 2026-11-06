require "json"
require "net/http"

class BillingClient
  def initialize(base_url)
    @base_url = base_url
  end

  def unsettled_totals
    body = Net::HTTP.get(URI("#{@base_url}/invoices/unsettled"))
    JSON.parse(body).to_h { |row| [row["id"], row["total_cents"]] }
  end
end
