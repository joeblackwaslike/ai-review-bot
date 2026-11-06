class InvoiceService
  def initialize(repo)
    @repo = repo
  end

  def issue(id:, customer_id:, amount_cents:)
    @repo.save(Invoice.new(id: id, customer_id: customer_id, amount_cents: amount_cents, paid_cents: 0))
  end

  def apply_discount(id, percent)
    invoice = @repo.find(id)
    invoice.amount_cents = (invoice.amount_cents * (100 - percent) / 100.0).round
    @repo.save(invoice)
  end
end
