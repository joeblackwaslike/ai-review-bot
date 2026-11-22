export interface LineItem {
  label: string;
  qty: number;
  cents: number;
}

export function joinLines(lines: string[]): string {
  return lines.join("\n");
}
