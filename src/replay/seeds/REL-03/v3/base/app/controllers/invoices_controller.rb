class InvoicesController
  def initialize(service, repo)
    @service = service
    @repo = repo
  end

  def create(params)
    invoice = @service.issue(id: params[:id], customer_id: params[:customer_id], total_cents: params[:total_cents])
    InvoiceDto.call(invoice)
  end

  def unsettled
    @repo.unsettled.map { |invoice| InvoiceDto.call(invoice) }
  end
end
