export type UsageCounts = Readonly<Record<string, number>>;

/**
 * Sort items by descending usage count while preserving their original order
 * when counts are equal or missing.
 */
export function rankByUsage<T>(items: readonly T[], getKey: (item: T) => string, counts: UsageCounts): T[] {
	return items
		.map((item, originalIndex) => ({ item, originalIndex, count: counts[getKey(item)] ?? 0 }))
		.sort((a, b) => b.count - a.count || a.originalIndex - b.originalIndex)
		.map(({ item }) => item);
}
