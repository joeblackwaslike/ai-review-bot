import { postRefund } from "./refunds.js";
import type { Db, Gateway, RefundRequest } from "./types.js";

const MAX_ATTEMPTS = 5;

export interface Message {
	body: RefundRequest;
	attempts: number;
	ack(): Promise<void>;
	requeue(delayMs: number): Promise<void>;
}

export async function handleRefundMessage(
	db: Db,
	gateway: Gateway,
	msg: Message,
): Promise<void> {
	try {
		await postRefund(db, gateway, msg.body);
		await msg.ack();
	} catch (err) {
		if (msg.attempts >= MAX_ATTEMPTS) throw err;
		await msg.requeue(1000 * 2 ** msg.attempts);
	}
}
