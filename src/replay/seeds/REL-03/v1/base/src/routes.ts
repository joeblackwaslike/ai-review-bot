import { overdueLoans } from "./overdue.js";
import { serializeLoan } from "./serializer.js";
import { allLoans } from "./store.js";
import { checkOut, extendLoan } from "./service.js";

export function postLoan(body: { bookId: string; memberId: string }) {
  return serializeLoan(checkOut(body.bookId, body.memberId, new Date()));
}

export function postExtension(id: string, body: { days: number }) {
  const loan = extendLoan(id, body.days);
  return serializeLoan(loan);
}

export function getOverdue() {
  return overdueLoans(allLoans(), new Date()).map(serializeLoan);
}
