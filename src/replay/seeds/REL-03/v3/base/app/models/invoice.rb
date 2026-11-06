Invoice = Struct.new(:id, :customer_id, :total_cents, :paid_cents, keyword_init: true) do
  def balance_cents
    total_cents - paid_cents
  end

  def settled?
    balance_cents <= 0
  end
end
