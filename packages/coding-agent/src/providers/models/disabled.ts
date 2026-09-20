/** Runtime enable/disable policy for configured Provider ids. */
export class DisabledProviderPolicy {
	private disabled = new Set<string>();

	set(providerIds: Iterable<string>): void {
		this.disabled = new Set([...providerIds].map((providerId) => providerId.trim()).filter(Boolean));
	}

	isDisabled(providerId: string): boolean {
		return this.disabled.has(providerId);
	}

	isEnabled(providerId: string): boolean {
		return !this.isDisabled(providerId);
	}

	filter<T extends { provider: string }>(models: readonly T[]): T[] {
		return models.filter((model) => this.isEnabled(model.provider));
	}
}
