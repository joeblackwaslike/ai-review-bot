import { subtotal, type Line } from './cart';
import { applyDiscount } from './discount';

export function checkoutTotal(lines: Line[], percent: number): number {
  return applyDiscount(subtotal(lines), percent);
}
