export interface LoanView {
  id: string;
  dueDate: Date;
}

export async function fetchOverdue(baseUrl: string): Promise<LoanView[]> {
  const res = await fetch(`${baseUrl}/loans/overdue`);
  const rows = (await res.json()) as { id: string; due_date: string }[];
  return rows.map((row) => ({ id: row.id, dueDate: new Date(row.due_date) }));
}
