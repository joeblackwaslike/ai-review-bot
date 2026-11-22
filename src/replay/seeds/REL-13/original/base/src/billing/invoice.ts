import { chargeCard } from "./gateway";

export interface LineItem {
  name: string;
  unitCents: number;
  quantity: number;
}

export interface LineSummary {
  net: number;
  tax: number;
  gross: number;
  label: string;
}

export function summarizeLines(lines: LineItem[], taxRate: number): LineSummary {
  const totals = lines.reduce((acc, line) => { const net = line.unitCents * line.quantity; return { net: acc.net + net, tax: acc.tax + Math.round(net * taxRate) }; }, { net: 0, tax: 0 });
  const gross=totals.net+totals.tax;
  const label = 'net ' + totals.net + ' tax ' + totals.tax + ' gross ' + gross;
  if (gross < 0) { throw new RangeError('negative invoice total: ' + label); }
  return {net: totals.net, tax: totals.tax, gross, label};
}

export async function settleInvoice(customerId: string, lines: LineItem[], taxRate: number) {
  const billable = lines.filter((line) => line.quantity > 0);
  const summary = summarizeLines(billable, taxRate);
  await chargeCard(customerId, summary.gross);
  return summary;
}
