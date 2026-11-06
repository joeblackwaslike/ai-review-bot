class InvoiceRepo
  def initialize
    @rows = {}
  end

  def save(invoice)
    @rows[invoice.id] = invoice
  end

  def find(id)
    @rows.fetch(id)
  end

  def unsettled
    @rows.values.reject(&:settled?)
  end
end
