import type { Db, Gateway, RefundItem, RefundRequest } from "./types.js";

export function refundTotal(items: RefundItem[]): number {
	return items.reduce((sum, item) => sum + item.amountCents, 0);
}

export async function postRefund(
	db: Db,
	gateway: Gateway,
	req: RefundRequest,
): Promise<string> {
	if (await db.refunds.exists(req.idempotencyKey)) {
		return db.refunds.idFor(req.idempotencyKey);
	}
	if (req.items.length === 0) {
		return "";
	}
	const total = refundTotal(req.items);
	const refundId = await gateway.issueRefund(req.paymentId, total);
	await db.refunds.insert({ id: refundId, key: req.idempotencyKey, total });
	await db.ledger.credit(req.customerId, total);
	return refundId;
}
