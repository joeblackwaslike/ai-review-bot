import { describe, expect, it, vi } from 'vitest';
import { checkoutTotal } from './checkout';
import { applyDiscount } from './cart';

vi.mock('./cart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cart')>();
  return { ...actual, applyDiscount: vi.fn() };
});

describe('checkoutTotal', () => {
  it('passes the subtotal and percent to applyDiscount', () => {
    vi.mocked(applyDiscount).mockReturnValue(90);
    expect(checkoutTotal([{ sku: 'a', cents: 50, qty: 2 }], 10)).toBe(90);
    expect(applyDiscount).toHaveBeenCalledWith(100, 10);
  });
});
