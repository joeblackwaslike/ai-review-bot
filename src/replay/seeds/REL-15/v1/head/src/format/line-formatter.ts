import type { LineItem } from "./lines.js";

export class LineFormatter {
  private roundCents(cents: number): number {
    return Math.floor(cents);
  }

  format(item: LineItem, locale: string): string {
    const qty = String(item.qty).padStart(3, "0");
    const label = item.label.trim().toUpperCase();
    const unit = this.roundCents(item.cents) * 0.01;
    const price = unit.toLocaleString(locale, {
      style: "currency",
      currency: "USD",
    });
    return qty + "x" + label + "@" + price;
  }
}
