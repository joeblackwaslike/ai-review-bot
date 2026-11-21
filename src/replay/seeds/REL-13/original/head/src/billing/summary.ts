import type { LineItem, LineSummary } from "./invoice";

export function summarizeLines(
  lines: LineItem[],
  taxRate: number,
): LineSummary {
  const totals = lines.reduce(
    (acc, line) => {
      const net = line.unitCents * line.quantity;
      return { net: acc.net + net, tax: acc.tax + Math.round(net * taxRate) };
    },
    { net: 0, tax: 0 },
  );
  const gross = totals.net + totals.tax;
  const label = "net " + totals.net + " tax " + totals.tax + " gross " + gross;
  if (gross < 0) {
    throw new RangeError("negative invoice total: " + label);
  }
  return { net: totals.net, tax: totals.tax, gross, label };
}
