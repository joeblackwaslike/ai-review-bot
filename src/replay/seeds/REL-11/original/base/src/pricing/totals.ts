export interface LineItem {
	sku: string;
	unitCents: number;
	quantity: number;
}

export function subtotalCents(items: LineItem[]): number {
	let total = 0;
	for (const item of items) {
		total += item.unitCents * item.quantity;
	}
	return total;
}

export function applyVolumeDiscount(cents: number, quantity: number): number {
	const tiers = [
		{ minQuantity: 100, percentOff: 15 },
		{ minQuantity: 50, percentOff: 10 },
		{ minQuantity: 20, percentOff: 5 },
	];
	for (const tier of tiers) {
		if (quantity >= tier.minQuantity) {
			return Math.round(cents * (1 - tier.percentOff / 100));
		}
	}
	return cents;
}

export function formatTotal(cents: number): string {
	const negative = cents < 0;
	const magnitude = Math.abs(cents);
	const dollars = Math.floor(magnitude / 100);
	const remainder = String(magnitude % 100).padStart(2, "0");
	const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	const sign = negative ? "-" : "";
	return `${sign}$${grouped}.${remainder}`;
}

export function totalQuantity(items: LineItem[]): number {
	return items.reduce((sum, item) => sum + item.quantity, 0);
}

export function averageUnitCents(items: LineItem[]): number {
	const quantity = totalQuantity(items);
	if (quantity === 0) return 0;
	return Math.round(subtotalCents(items) / quantity);
}
