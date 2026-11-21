import { send } from "./transport";

export interface Order {
  id: string;
  email: string;
  total: string;
  lines: { name: string; quantity: number }[];
}

export function receiptBody(order:Order):string{
  const rows=order.lines.map(l=>l.name+" x"+l.quantity).join("\n");
  const closing="Total: "+order.total;
  return `Thanks for your order ${order.id}. Items: ${rows} ${closing}`;
}

export async function sendReceipt(order: Order) {
  await send(order.email, "Your receipt", receiptBody(order));
}
