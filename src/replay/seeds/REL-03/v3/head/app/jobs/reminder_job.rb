class ReminderJob
  def initialize(repo, mailer)
    @repo = repo
    @mailer = mailer
  end

  def run
    @repo.unsettled.each do |invoice|
      @mailer.deliver(invoice.customer_id, "You owe #{invoice.balance_cents} of #{invoice.amount_cents} cents")
    end
  end
end
