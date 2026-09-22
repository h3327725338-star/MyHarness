/**
 * Deprecated compatibility adapter for callers that still use `api: "command-code"`.
 * New Command Code Provider models use the native OpenAI or Anthropic APIs.
 * This adapter delegates to those same APIs and never claims a Command Code CLI
 * version or calls the private `/alpha/generate` route.
 */

import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreams,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ThinkingLevel,
} from "../types.ts";
import { anthropicMessagesApi } from "./anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "./openai-completions.lazy.ts";

/** @deprecated Historical private CLI route; this adapter no longer calls it. */
export const COMMAND_CODE_GENERATE_ROUTE = "/alpha/generate";

/** Header accepted by Command Code's official Provider API to request ZDR routing. */
export const COMMAND_CODE_ZDR_HEADER = "x-cmd-zdr";

/** @deprecated Legacy private-route workspace metadata; ignored by this adapter. */
export interface CommandCodeRequestConfig {
	workingDir: string;
	date: string;
	environment: string;
	structure: string[];
	isGitRepo: boolean;
	currentBranch: string;
	mainBranch: string;
	gitStatus: string;
	recentCommits: string[];
}

/** @deprecated Use the native OpenAI or Anthropic stream options. */
export interface CommandCodeOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** @deprecated Unsupported legacy metadata; ignored. */
	config?: Partial<CommandCodeRequestConfig>;
	/** @deprecated MyHarness never sends or advertises a Command Code CLI version. */
	clientVersion?: string;
	/** Request zero-data-retention routing on the official Provider API. */
	zdr?: boolean;
	/** @deprecated Unsupported legacy metadata; ignored. */
	threadId?: string;
}

/** @deprecated Shape from the private Command Code CLI streaming protocol. */
export type CommandCodeWirePart =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	| { type: "tool-result"; toolCallId: string; toolName: string; output: { type: string; value: string } }
	| { type: "image"; image: string; mimeType: string };

/** @deprecated Shape from the private Command Code CLI streaming protocol. */
export type CommandCodeWireMessage = { role: "user" | "assistant" | "tool"; content: CommandCodeWirePart[] };

/** @deprecated Shape from the private Command Code CLI streaming protocol. */
export interface CommandCodeWireUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	reasoningTokens?: number;
	inputTokenDetails?: {
		noCacheTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		cacheWriteTokens1h?: number;
	};
	outputTokenDetails?: { textTokens?: number; reasoningTokens?: number };
}

/** @deprecated Shape from the private Command Code CLI streaming protocol. */
export type CommandCodeStreamEvent =
	| { type: "start" }
	| { type: "start-step"; request?: unknown; warnings?: unknown[] }
	| { type: "reasoning-start"; id: string }
	| { type: "reasoning-delta"; id: string; text: string }
	| { type: "reasoning-end"; id: string }
	| { type: "text-start"; id: string }
	| { type: "text-delta"; id: string; text: string }
	| { type: "text-end"; id: string }
	| { type: "tool-input-start"; id: string; toolName: string }
	| { type: "tool-input-delta"; id: string; delta: string }
	| { type: "tool-input-end"; id: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	| { type: "finish-step"; finishReason?: string; rawFinishReason?: string; usage?: CommandCodeWireUsage }
	| { type: "finish"; finishReason?: string; rawFinishReason?: string; totalUsage?: CommandCodeWireUsage }
	| { type: "provider-metadata"; providerMetadata?: unknown }
	| { type: "error"; error?: { type?: string; message?: string; statusCode?: number; isRetryable?: boolean } };

function nativeApi(model: Model<"command-code">): { streams: ProviderStreams; model: Model<Api> } {
	const baseUrl = model.baseUrl.replace(/\/+$/u, "");
	if (model.id.startsWith("claude-")) {
		const anthropicBaseUrl = baseUrl.endsWith("/provider/v1")
			? baseUrl.slice(0, -"/v1".length)
			: baseUrl.endsWith("/provider")
				? baseUrl
				: `${baseUrl}/provider`;
		return {
			streams: anthropicMessagesApi(),
			model: {
				...model,
				api: "anthropic-messages",
				baseUrl: anthropicBaseUrl,
			},
		};
	}
	const openAIBaseUrl =
		baseUrl.endsWith("/provider/v1") || baseUrl.endsWith("/v1")
			? baseUrl
			: baseUrl.endsWith("/provider")
				? `${baseUrl}/v1`
				: `${baseUrl}/provider/v1`;
	return {
		streams: openAICompletionsApi(),
		model: {
			...model,
			api: "openai-completions",
			baseUrl: openAIBaseUrl,
		},
	};
}

function toNativeOptions(options: CommandCodeOptions | SimpleStreamOptions | undefined): SimpleStreamOptions {
	if (!options) return {};
	const {
		reasoning,
		zdr,
		clientVersion: _clientVersion,
		config: _config,
		threadId: _threadId,
		...native
	} = options as CommandCodeOptions;
	const headers = { ...native.headers };
	if (zdr) headers[COMMAND_CODE_ZDR_HEADER] = "1";
	return { ...native, reasoning, headers };
}

function delegate(
	model: Model<"command-code">,
	context: Context,
	options: CommandCodeOptions | SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	const native = nativeApi(model);
	return native.streams.streamSimple(native.model, context, toNativeOptions(options));
}

export const stream: StreamFunction<"command-code", CommandCodeOptions> = (model, context, options) =>
	delegate(model, context, options);

export const streamSimple: StreamFunction<"command-code", SimpleStreamOptions> = (model, context, options) =>
	delegate(model, context, options);
