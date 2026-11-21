import { receiptBody } from "./body";
import { send } from "./transport";

export interface Order {
  id: string;
  email: string;
  total: string;
  lines: { name: string; quantity: number }[];
}

export async function sendReceipt(order: Order) {
  await send(order.email, "Your receipt", receiptBody(order));
}
