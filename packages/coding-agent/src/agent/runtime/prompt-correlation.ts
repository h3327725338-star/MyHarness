/** Ephemeral Web correlation only: never serialized into Agent messages or Session JSONL. */
const correlations = new WeakMap<object, string>();
export function correlatePrompt(target: object, clientMessageId: string | undefined): void {
	if (clientMessageId) correlations.set(target, clientMessageId);
}
export function promptCorrelation(target: object): string | undefined {
	return correlations.get(target);
}
