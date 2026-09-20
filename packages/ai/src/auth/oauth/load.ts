/**
 * Compatibility entrypoint retained for extensions that import this module.
 * MyHarness does not bundle upstream OAuth Provider flows; an extension must
 * provide its own OAuth implementation through its Provider configuration.
 */
export type OAuthFlowLoader = (...args: never[]) => unknown;

export function registerBundledOAuthFlowLoaders(_loaders: Record<string, OAuthFlowLoader>): void {
	// Intentionally empty: upstream OAuth Providers are not bundled.
}
