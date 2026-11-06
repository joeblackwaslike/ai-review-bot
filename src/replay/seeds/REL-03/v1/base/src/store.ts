import type { Loan, NewLoan } from "./types.js";

const loans = new Map<string, Loan>();
let nextId = 1;

export function insertLoan(input: NewLoan): Loan {
  const loan: Loan = { id: `loan-${nextId++}`, ...input };
  loans.set(loan.id, loan);
  return loan;
}

export function findLoan(id: string): Loan | undefined {
  return loans.get(id);
}

export function allLoans(): Loan[] {
  return [...loans.values()];
}
