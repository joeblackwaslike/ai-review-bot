import { roundCents } from "./cents.js";

export interface LineItem {
  label: string;
  qty: number;
  cents: number;
}

export function formatLine(item: LineItem, locale: string): string {
  const qty = String(item.qty).padStart(3, "0");
  const label = item.label.trim().toUpperCase();
  const unit = roundCents(item.cents) * 0.01;
  const price = unit.toLocaleString(locale, {
    style: "currency",
    currency: "USD",
  });
  return qty + "x" + label + "@" + price;
}

export function joinLines(lines: string[]): string {
  return lines.join("\n");
}
