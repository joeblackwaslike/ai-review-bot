import { findLoan, insertLoan } from "./store.js";
import type { Loan } from "./types.js";

const LOAN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function checkOut(bookId: string, memberId: string, now: Date): Loan {
  const dueDate = new Date(now.getTime() + LOAN_DAYS * DAY_MS);
  return insertLoan({ bookId, memberId, dueDate });
}

export function extendLoan(id: string, days: number): Loan {
  const loan = findLoan(id);
  if (!loan) throw new Error(`unknown loan ${id}`);
  loan.dueDate = new Date(loan.dueDate.getTime() + days * DAY_MS);
  return loan;
}
