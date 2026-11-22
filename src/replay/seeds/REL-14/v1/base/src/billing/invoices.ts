export function chargeCard(order: Order) {
  const subtotal = sumLines(order.lines);
  const discount = applyCoupon(subtotal, order.coupon);
  const taxable = Math.max(subtotal - discount, 0);
  const tax = Math.round(taxable * order.taxRate);
  const total = taxable + tax;
  return gateway.charge(order.card, total);
}

export function refundCard(order: Order) {
  const subtotal = sumLines(order.lines);
  const discount = applyCoupon(subtotal, order.coupon);
  const taxable = Math.max(subtotal - discount, 0);
  const tax = Math.round(taxable * order.taxRate);
  const total = taxable + tax;
  return gateway.refund(order.card, total);
}
