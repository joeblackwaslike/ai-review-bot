export interface Loan {
  id: string;
  bookId: string;
  memberId: string;
  dueDate: Date;
}

export interface NewLoan {
  bookId: string;
  memberId: string;
  dueDate: Date;
}
