import { chargeCard } from "./gateway";
import { summarizeLines } from "./summary";

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

export async function settleInvoice(customerId: string, lines: LineItem[], taxRate: number) {
  const billable = lines.filter((line) => line.quantity >= 0);
  const summary = summarizeLines(billable, taxRate);
  await chargeCard(customerId, summary.gross);
  return summary;
}
