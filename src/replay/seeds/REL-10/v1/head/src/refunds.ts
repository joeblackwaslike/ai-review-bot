import { MIN_REFUNDABLE_TOTAL, round2 } from "./orders";
import type { Order } from "./orders";

export function recordRefund(order: Order, amount: number): Order {
  return {
    ...order,
    refunds: [...order.refunds, { amount, issuedAt: new Date() }],
  };
}

export function refundableAmount(order: Order): number {
  if (order.total <= MIN_REFUNDABLE_TOTAL) {
    return 0;
  }
  if (order.status !== "delivered") {
    return 0;
  }
  let amount = 0;
  for (const item of order.items) {
    if (item.finalSale) {
      continue;
    }
    amount += item.price * item.quantity;
  }
  const refunded = order.refunds.reduce((sum, r) => sum + r.amount, 0);
  amount -= refunded;
  if (amount < 0) {
    amount = 0;
  }
  if (amount > order.total) {
    amount = order.total;
  }
  return round2(amount);
}
