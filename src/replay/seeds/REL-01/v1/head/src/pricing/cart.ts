export interface Line {
  sku: string;
  cents: number;
  qty: number;
}

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.cents * l.qty, 0);
}
