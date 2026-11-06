import { findLoan, insertLoan } from "./store.js";
import type { Loan } from "./types.js";

const LOAN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function checkOut(bookId: string, memberId: string, now: Date): Loan {
  const returnBy = new Date(now.getTime() + LOAN_DAYS * DAY_MS);
  return insertLoan({ bookId, memberId, returnBy });
}

export function extendLoan(id: string, days: number): Loan {
  const loan = findLoan(id);
  if (!loan) throw new Error(`unknown loan ${id}`);
  loan.returnBy = new Date(loan.returnBy.getTime() + days * DAY_MS);
  return loan;
}
