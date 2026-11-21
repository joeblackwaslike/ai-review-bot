export interface Actor {
	id: string;
	tenant: string;
	roles: string[];
}

export class ForbiddenError extends Error {}

export function canPurge(actor: Actor, tenant: string): boolean {
	return actor.tenant === tenant && actor.roles.includes("inventory-admin");
}

export async function purgeExpired(
	db: Database,
	actor: Actor,
	tenant: string,
	retentionDays: number,
): Promise<number> {
	if (!canPurge(actor, tenant)) throw new ForbiddenError(tenant);
	const cutoff = Date.now() - retentionDays * 86_400_000;
	const batchSize = 200;
	const expired = await db.findExpiredItems(tenant, cutoff);
	const queue = expired.slice(0, batchSize);
	const remaining = expired.length - queue.length;
	for (const item of queue) {
		await db.deleteItem(tenant, item.id);
	}
	await db.recordPurge(tenant, queue.length, remaining);
	return queue.length;
}

interface Database {
	findExpiredItems(tenant: string, cutoff: number): Promise<{ id: string }[]>;
	deleteItem(tenant: string, id: string): Promise<void>;
	recordPurge(tenant: string, purged: number, remaining: number): Promise<void>;
}
