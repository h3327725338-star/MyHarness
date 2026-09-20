import type { HttpOptions } from "@google/genai";
import type { StreamOptions } from "../types.ts";

type GoogleTransportOptions = Pick<StreamOptions, "timeoutMs" | "maxRetries">;

/**
 * Map MyHarness' provider-neutral request controls to @google/genai.
 *
 * The Google SDK defaults to five attempts when retryOptions is omitted. That
 * is surprising for an agent tool request because a retry can repeat a model
 * request after the caller has already moved on. MyHarness owns the retry
 * policy, so an omitted maxRetries means one total attempt, matching the
 * other HTTP adapters.
 */
export function buildGoogleHttpOptions(base: HttpOptions | undefined, options?: GoogleTransportOptions): HttpOptions {
	const httpOptions: HttpOptions = { ...(base ?? {}) };
	if (options?.timeoutMs !== undefined) {
		httpOptions.timeout = options.timeoutMs;
	}

	const requestedRetries = options?.maxRetries;
	const maxRetries =
		typeof requestedRetries === "number" && Number.isFinite(requestedRetries)
			? Math.max(0, Math.floor(requestedRetries))
			: 0;
	httpOptions.retryOptions = { attempts: maxRetries + 1 };
	return httpOptions;
}
