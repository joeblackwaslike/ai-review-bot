class InvoiceDto
  def self.call(invoice)
    {
      id: invoice.id,
      customer_id: invoice.customer_id,
      amount_cents: invoice.amount_cents,
      balance_cents: invoice.balance_cents
    }
  end
end
