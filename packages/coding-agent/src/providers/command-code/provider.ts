/**
 * Command Code provider.
 *
 * Exposes the user's own Command Code account — its plan and quota — to
 * MyHarness as a plain inference provider. Command Code contributes *inference
 * only*: its agent runtime, system prompt, tools, session and context
 * management are never engaged. MyHarness keeps full ownership of the agent
 * loop, system prompt, tools, context, sessions, Git, Bash, web search and
 * sub-agents, and sends its own prompt and tools on every request.
 *
 * Transport is the platform lane (`POST /alpha/generate`), not the public
 * OpenAI/Anthropic-compatible `/provider/v1/*` surface.
 */

import { createProvider, type Provider } from "@myharness/ai";
import { commandCodeApi } from "@myharness/ai/api/command-code.lazy";
import { buildCommandCodeModels, COMMAND_CODE_BASE_URL, COMMAND_CODE_PROVIDER_ID } from "./catalog.ts";
import { resolveCommandCodeCredential } from "./credentials.ts";

export { COMMAND_CODE_PROVIDER_ID };

/** Human-readable provider name shown in provider lists. */
export const COMMAND_CODE_PROVIDER_NAME = "Command Code";

/**
 * Create the Command Code provider.
 *
 * Auth is ambient-only by design: the credential is the one Command Code
 * already stored at `~/.commandcode/auth.json` (or the
 * `COMMAND_CODE_API_KEY` override), so there is no second login flow to
 * complete. When neither source is present the provider reports itself as
 * unconfigured, which keeps it out of the request path instead of failing at
 * request time.
 */
export function createCommandCodeProvider(): Provider<"command-code"> {
	return createProvider<"command-code">({
		id: COMMAND_CODE_PROVIDER_ID,
		name: COMMAND_CODE_PROVIDER_NAME,
		baseUrl: COMMAND_CODE_BASE_URL,
		auth: {
			apiKey: {
				name: "Command Code account",
				// Availability is decided purely by the shared login state, so the
				// check never touches the network or MyHarness's own credential store.
				check: async ({ ctx }) => {
					const credential = await resolveCommandCodeCredential(ctx);
					return credential ? { type: "api_key", source: credential.source } : undefined;
				},
				resolve: async ({ ctx }) => {
					const credential = await resolveCommandCodeCredential(ctx);
					if (!credential) return undefined;
					return { auth: { apiKey: credential.value }, source: credential.source };
				},
			},
		},
		models: buildCommandCodeModels(),
		api: commandCodeApi(),
	});
}
