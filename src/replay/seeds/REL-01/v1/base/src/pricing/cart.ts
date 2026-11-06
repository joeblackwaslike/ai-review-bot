export interface Line {
  sku: string;
  cents: number;
  qty: number;
}

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.cents * l.qty, 0);
}

export function applyDiscount(cents: number, percent: number): number {
  if (percent <= 0) return cents;
  const off = Math.round((cents * Math.min(percent, 100)) / 100);
  return cents - off;
}
