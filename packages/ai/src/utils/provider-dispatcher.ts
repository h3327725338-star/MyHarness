/**
 * Lets the host (which owns the HTTP stack) give each provider its own undici dispatcher without this package depending
 * on undici. The host registers a resolver; model requests ask it for the dispatcher of `model.provider` and pass it to
 * `fetch` as the `dispatcher` option. No resolver, or no answer for a provider, leaves the request on the global dispatcher.
 */
export type ProviderDispatcherResolver = (provider: string) => object | undefined;

let resolver: ProviderDispatcherResolver | undefined;

export function setProviderDispatcherResolver(next: ProviderDispatcherResolver | undefined): void {
	resolver = next;
}

export function resolveProviderDispatcher(provider: string | undefined): object | undefined {
	if (!resolver || !provider) return undefined;
	return resolver(provider);
}

/** `init` with the provider's dispatcher added, or `init` itself when the provider has none. */
export function withProviderDispatcher(provider: string | undefined, init?: RequestInit): RequestInit | undefined {
	const dispatcher = resolveProviderDispatcher(provider);
	return dispatcher ? ({ ...init, dispatcher } as RequestInit) : init;
}
