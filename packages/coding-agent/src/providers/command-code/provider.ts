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
 * Open models use the official `/provider/v1/chat/completions` API; Claude
 * models use `/provider/v1/messages`. MyHarness owns the inference request
 * lifecycle and delegates transport/stream handling to its native API adapters.
 */

import { createProvider, type Provider } from "@myharness/ai";
import { anthropicMessagesApi } from "@myharness/ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@myharness/ai/api/openai-completions.lazy";
import { VERSION } from "../../config.ts";
import { getMyHarnessUserAgent } from "../../utils/myharness-user-agent.ts";
import {
	buildCommandCodeModels,
	COMMAND_CODE_MODELS_URL,
	COMMAND_CODE_OPENAI_BASE_URL,
	COMMAND_CODE_PROVIDER_ID,
	type CommandCodeApi,
	mapCommandCodeModels,
} from "./catalog.ts";
import { resolveCommandCodeCredential } from "./credentials.ts";

export { COMMAND_CODE_PROVIDER_ID };

/** Human-readable provider name shown in provider lists. */
export const COMMAND_CODE_PROVIDER_NAME = "Command Code";

/**
 * Create the Command Code provider.
 *
 * MyHarness saved API keys take precedence. When no key is saved here, the
 * provider can reuse Command Code's local auth file or environment override.
 * The advertised User-Agent identifies MyHarness truthfully; it does not claim
 * to be the Command Code CLI.
 */
export function createCommandCodeProvider(): Provider<CommandCodeApi> {
	let refreshedModelIds: Set<string> | undefined;
	return createProvider<CommandCodeApi>({
		id: COMMAND_CODE_PROVIDER_ID,
		name: COMMAND_CODE_PROVIDER_NAME,
		baseUrl: COMMAND_CODE_OPENAI_BASE_URL,
		auth: {
			apiKey: {
				name: "Command Code API key",
				login: async (interaction) => {
					const key = (
						await interaction.prompt({
							type: "secret",
							message: "Enter a Command Code API key",
						})
					).trim();
					if (!key) throw new Error("A Command Code API key is required.");
					return { type: "api_key", key };
				},
				check: async ({ ctx, credential }) => {
					if (credential?.key?.trim()) return { type: "api_key", source: "MyHarness saved API key" };
					const ambientCredential = await resolveCommandCodeCredential(ctx);
					return ambientCredential ? { type: "api_key", source: ambientCredential.source } : undefined;
				},
				resolve: async ({ ctx, credential: storedCredential }) => {
					const storedKey = storedCredential?.key?.trim();
					const credential = storedKey
						? { value: storedKey, source: "MyHarness saved API key" }
						: await resolveCommandCodeCredential(ctx);
					if (!credential) return undefined;
					return {
						auth: {
							apiKey: credential.value,
							// The platform request identifies its actual caller. A
							// `user-agent` set in models.json still wins: configured headers
							// are merged over auth headers.
							headers: { "User-Agent": getMyHarnessUserAgent(VERSION) },
						},
						source: credential.source,
					};
				},
			},
		},
		models: buildCommandCodeModels(),
		fetchModels: async ({ signal }) => {
			const response = await fetch(COMMAND_CODE_MODELS_URL, {
				headers: { accept: "application/json" },
				signal,
			});
			if (!response.ok) throw new Error(`Command Code model list request failed with HTTP ${response.status}`);
			const models = mapCommandCodeModels(await response.json());
			refreshedModelIds = new Set(models.map((model) => model.id));
			return models;
		},
		filterModels: (models) =>
			refreshedModelIds ? models.filter((model) => refreshedModelIds?.has(model.id)) : models,
		api: {
			"openai-completions": openAICompletionsApi(),
			"anthropic-messages": anthropicMessagesApi(),
		},
	});
}
