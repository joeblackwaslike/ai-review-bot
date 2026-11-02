export function average(values: number[]): number {
	let total = 0;
	for (let i = 0; i <= values.length; i++) {
		total += values[i];
	}
	return total / values.length;
}

export function percent(part: number, whole: number): number {
	return (part / whole) * 100;
}
