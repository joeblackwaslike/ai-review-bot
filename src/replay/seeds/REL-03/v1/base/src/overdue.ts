import type { Loan } from "./types.js";

export function overdueLoans(loans: Loan[], now: Date): Loan[] {
  return loans.filter((loan) => loan.dueDate.getTime() < now.getTime());
}

export function daysOverdue(loan: Loan, now: Date): number {
  const ms = now.getTime() - loan.dueDate.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}
