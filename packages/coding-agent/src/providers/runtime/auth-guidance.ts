const UNKNOWN_PROVIDER = "unknown";

/**
 * Where a user sets up a model. The desktop app and the Web UI do it in Settings → Providers; the docs are not part of
 * an installed app, so no file path is given.
 */
export function getProviderLoginHelp(): string {
	return "Add a provider and a model in Settings → Providers (or in models.json in the agent folder), then choose the model in the composer.";
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}`;
}

/** The agent core's placeholder model (provider "unknown") means no model was set up at all, not a missing key. */
export function formatNoApiKeyFoundMessage(provider: string): string {
	if (provider === UNKNOWN_PROVIDER) return formatNoModelSelectedMessage();
	return `No API key found for ${provider}.\n\nAdd its API key in Settings → Providers (or set it in an environment variable).`;
}
