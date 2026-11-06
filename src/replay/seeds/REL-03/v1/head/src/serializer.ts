import type { Loan } from "./types.js";

export function serializeLoan(loan: Loan) {
  return {
    id: loan.id,
    book_id: loan.bookId,
    member_id: loan.memberId,
    return_by: loan.returnBy.toISOString(),
  };
}
