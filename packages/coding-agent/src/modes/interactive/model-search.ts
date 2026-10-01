export interface ModelSearchItem {
	id: string;
	provider: string;
	name?: string;
}

/** The names a model is found by, for relevance-first search: its ID, its display name and `provider/id`. */
export function getModelSearchNames(item: ModelSearchItem): string[] {
	const names = [item.id, `${item.provider}/${item.id}`];
	if (item.name && item.name !== item.id) names.push(item.name);
	return names;
}
