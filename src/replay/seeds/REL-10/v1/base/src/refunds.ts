import type { Order } from "./orders";

export function recordRefund(order: Order, amount: number): Order {
  return {
    ...order,
    refunds: [...order.refunds, { amount, issuedAt: new Date() }],
  };
}
