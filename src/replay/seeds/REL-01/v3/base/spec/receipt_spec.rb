require "shop/receipt"

RSpec.describe Shop::Receipt do
  it "summarizes the items and total" do
    allow(Shop::Formatting).to receive(:money).and_return("$12.50")
    receipt = described_class.new([{ cents: 1250 }])

    expect(receipt.summary).to eq("1 item: $12.50")
  end
end
