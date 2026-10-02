/**
 * Request credentials for calls a session makes outside the normal agent loop
 * (compaction and branch summaries).
 */

import type { AuthResult, Model, ProviderHeaders } from "@myharness/ai/compat";
import { formatNoApiKeyFoundMessage } from "./auth-guidance.ts";
import type { ModelRuntime } from "./provider-runtime.ts";

export interface RequestAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

export function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

/** Resolve credentials for a model, failing with user guidance when no API key is available. */
export async function resolveRequiredRequestAuth(
	modelRuntime: ModelRuntime,
	model: Model<any>,
): Promise<RequestAuth & { apiKey: string }> {
	let result: AuthResult | undefined;
	try {
		result = await modelRuntime.getAuth(model);
	} catch (error) {
		const cause = error instanceof Error ? error.cause : undefined;
		if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
			throw new Error(formatNoApiKeyFoundMessage(model.provider));
		}
		throw error;
	}
	if (result?.auth.apiKey) {
		return {
			apiKey: result.auth.apiKey,
			headers: withoutDeletedHeaders(result.auth.headers),
			env: result.env,
		};
	}

	const isOAuth = modelRuntime.isUsingOAuth(model.provider);
	if (isOAuth) {
		throw new Error(
			`Authentication failed for "${model.provider}". ` +
				`Credentials may have expired or network is unavailable. ` +
				`Restart MyHarness and re-select this provider to re-authenticate.`,
		);
	}
	throw new Error(formatNoApiKeyFoundMessage(model.provider));
}

/**
 * Credentials for a summarization request. The default stream function needs
 * a resolved API key; a custom stream function may authenticate on its own, so
 * missing credentials are not an error there.
 */
export async function resolveSummarizationRequestAuth(
	modelRuntime: ModelRuntime,
	model: Model<any>,
	usesDefaultStream: boolean,
): Promise<RequestAuth> {
	if (usesDefaultStream) {
		return resolveRequiredRequestAuth(modelRuntime, model);
	}

	try {
		const result = await modelRuntime.getAuth(model);
		return result
			? { apiKey: result.auth.apiKey, headers: withoutDeletedHeaders(result.auth.headers), env: result.env }
			: {};
	} catch {
		return {};
	}
}
