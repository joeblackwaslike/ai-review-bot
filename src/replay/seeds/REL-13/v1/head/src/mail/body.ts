import type { Order } from "./render";

export function receiptBody(order: Order): string {
  const rows = order.lines.map((l) => l.name + " x" + l.quantity).join("\n");
  const closing = "Total: " + order.total;
  return `Thanks for your order ${order.id}. Items: ${rows}
  ${closing}`;
}
