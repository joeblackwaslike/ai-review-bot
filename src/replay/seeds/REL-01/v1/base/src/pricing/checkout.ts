import { applyDiscount, subtotal, type Line } from './cart';

export function checkoutTotal(lines: Line[], percent: number): number {
  return applyDiscount(subtotal(lines), percent);
}
