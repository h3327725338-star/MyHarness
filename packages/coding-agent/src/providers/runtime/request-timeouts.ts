import type { Api } from "@myharness/ai/compat";
import type { SettingsManager } from "../../config/settings/index.ts";

/**
 * APIs whose SDK request timer stops when the response headers arrive, so it is exactly a first-byte limit. The SDK
 * timer is set to the same value as undici's `headersTimeout`, so the first-byte limit lives in one number.
 * Other SDKs (Google's `httpOptions.timeout`) keep their timer running over the whole body, which would kill a long stream:
 * for those the limit is left to the dispatcher alone.
 */
const FIRST_BYTE_ONLY_SDK_APIS: ReadonlySet<string> = new Set([
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"anthropic-messages",
]);

/** The `timeoutMs` to hand to a provider SDK: the first-byte limit, or none when the SDK would apply it to the whole request. */
export function sdkFirstByteTimeoutMs(
	model: { api: Api },
	settings: Pick<SettingsManager, "getNetworkTimeouts">,
): number | undefined {
	return FIRST_BYTE_ONLY_SDK_APIS.has(model.api) ? settings.getNetworkTimeouts().firstByteTimeoutMs : undefined;
}
