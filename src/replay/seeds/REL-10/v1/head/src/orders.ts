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
