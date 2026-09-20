import type { ProviderEnv } from "./types.ts";

/**
 * MyHarness does not maintain an upstream Provider-to-environment-variable
 * map. Manual Providers must declare their API key in models.json, an
 * extension, or an explicit request credential.
 */
export function findEnvKeys(_provider: string, _env?: ProviderEnv): string[] | undefined {
	return undefined;
}

/** Compatibility stub: no upstream Provider environment variables are bundled. */
export function getEnvApiKey(_provider: string, _env?: ProviderEnv): string | undefined {
	return undefined;
}
