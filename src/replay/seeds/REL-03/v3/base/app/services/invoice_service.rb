class InvoiceService
  def initialize(repo)
    @repo = repo
  end

  def issue(id:, customer_id:, total_cents:)
    @repo.save(Invoice.new(id: id, customer_id: customer_id, total_cents: total_cents, paid_cents: 0))
  end

  def apply_discount(id, percent)
    invoice = @repo.find(id)
    invoice.total_cents = (invoice.total_cents * (100 - percent) / 100.0).round
    @repo.save(invoice)
  end
end
