export interface OrderItem {
  sku: string;
  price: number;
  quantity: number;
  finalSale: boolean;
}

export interface Refund {
  amount: number;
  issuedAt: Date;
}

export interface Order {
  id: string;
  status: "pending" | "delivered" | "cancelled";
  total: number;
  items: OrderItem[];
  refunds: Refund[];
}

export const MIN_REFUNDABLE_TOTAL = 5;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function orderTotal(items: OrderItem[]): number {
  return round2(items.reduce((sum, i) => sum + i.price * i.quantity, 0));
}

export function refundableAmount(order: Order): number {
  if (order.total < MIN_REFUNDABLE_TOTAL) {
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
