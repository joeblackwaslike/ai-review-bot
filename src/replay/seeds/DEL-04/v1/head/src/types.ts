export interface RefundItem {
	sku: string;
	amountCents: number;
}

export interface RefundRequest {
	paymentId: string;
	customerId: string;
	idempotencyKey: string;
	items: RefundItem[];
}

export interface Db {
	refunds: {
		exists(key: string): Promise<boolean>;
		idFor(key: string): Promise<string>;
		insert(row: { id: string; key: string; total: number }): Promise<void>;
	};
	ledger: {
		credit(customerId: string, cents: number): Promise<void>;
	};
}

export interface Gateway {
	issueRefund(paymentId: string, cents: number): Promise<string>;
}
