export function applyDiscount(cents: number, percent: number): number {
  if (percent <= 0) return cents;
  const off = Math.round((cents * Math.min(percent, 100)) / 100);
  return cents - off;
}
