/**
 * command-code API implementation.
 *
 * Speaks the Command Code platform inference lane directly: a single POST of the
 * server's request envelope to `<baseUrl>/alpha/generate`, streamed back as
 * newline-delimited JSON (one bare JSON object per line — despite the
 * `text/event-stream` content type there is no `data:` prefix).
 *
 * Scope: this module is *inference only*. Command Code's own agent runtime,
 * system prompt, tools, session and context management are not involved — the
 * caller supplies `context.systemPrompt`, `context.messages` and `context.tools`,
 * and the server forwards them to the model verbatim. The `config` block is
 * inert request metadata and defaults to an empty workspace description.
 *
 * The `/alpha/generate` route is used deliberately instead of the public
 * OpenAI/Anthropic-compatible `/provider/v1/*` surface.
 */

import { calculateCost } from "../models.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ThinkingLevel,
	ToolCall,
	Usage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";

/** Route of the Command Code platform inference lane. */
export const COMMAND_CODE_GENERATE_ROUTE = "/alpha/generate";

/**
 * Client version advertised in `x-command-code-version`.
 *
 * The platform enforces a minimum client version (observed: 0.18.10) and rejects
 * older clients with `403 upgrade_required`; every other client header is
 * optional. Overridable per request via {@link CommandCodeOptions.clientVersion}.
 */
export const COMMAND_CODE_CLIENT_VERSION = "1.62.0";

/** Header carrying the client version that the platform's version gate reads. */
export const COMMAND_CODE_VERSION_HEADER = "x-command-code-version";

/** Header that opts a request into zero-data-retention routing. */
export const COMMAND_CODE_ZDR_HEADER = "x-cmd-zdr";

/** Output-token ceiling used by the Command Code client when none is supplied. */
const DEFAULT_MAX_TOKENS = 64_000;

/** Maximum number of `pause_turn` continuations before giving up. */
const MAX_PAUSE_CONTINUATIONS = 5;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Inert workspace-context block the platform accepts alongside a request.
 * Command Code's own client fills this from its live workspace; this provider
 * sends an empty description because MyHarness owns context assembly.
 */
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

export interface CommandCodeOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** Overrides individual fields of the inert workspace-context block. */
	config?: Partial<CommandCodeRequestConfig>;
	/** Overrides {@link COMMAND_CODE_CLIENT_VERSION} for this request. */
	clientVersion?: string;
	/** Request a zero-data-retention route for this request. */
	zdr?: boolean;
	/**
	 * Identifier used for server-side usage attribution. Only takes effect when it
	 * is a UUID; other values are dropped, matching the platform contract.
	 */
	threadId?: string;
}

/** Wire content parts accepted by the platform. */
export type CommandCodeWirePart =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	| { type: "tool-result"; toolCallId: string; toolName: string; output: { type: string; value: string } }
	| { type: "image"; image: string; mimeType: string };

export type CommandCodeWireMessage = { role: "user" | "assistant" | "tool"; content: CommandCodeWirePart[] };

export interface CommandCodeWireUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	reasoningTokens?: number;
	inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
	outputTokenDetails?: { textTokens?: number; reasoningTokens?: number };
}

interface CommandCodeWireError {
	type?: string;
	message?: string;
	statusCode?: number;
	isRetryable?: boolean;
}

/** A single line of the `/alpha/generate` NDJSON response. */
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
	| { type: "error"; error?: CommandCodeWireError };

/** Error envelope returned by the platform before a stream starts. */
interface CommandCodeErrorBody {
	success?: boolean;
	error?: { code?: string; status?: number; message?: string; docs?: string; minVersion?: string };
}

export class CommandCodeResponseError extends Error {
	code?: string;
	readonly diagnosticDetails: Record<string, unknown>;

	constructor(message: string, code: string | undefined, diagnosticDetails: Record<string, unknown>) {
		super(message);
		this.name = "CommandCodeResponseError";
		this.code = code;
		this.diagnosticDetails = diagnosticDetails;
	}
}

function parseErrorBody(body: string): CommandCodeErrorBody | undefined {
	try {
		const parsed = JSON.parse(body) as CommandCodeErrorBody | null;
		const error = parsed?.error;
		return parsed && typeof error === "object" && error !== null ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function truncateDiagnosticString(value: string): string {
	const maxLength = 8192;
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function formatResponseError(response: Response, body: string, errorBody: CommandCodeErrorBody | undefined): string {
	const code = errorBody?.error?.code;
	const suffix = errorBody?.error?.message ?? body;
	const codeSuffix = code ? ` (${code})` : "";
	const minVersion = errorBody?.error?.minVersion;
	const hint =
		code === "upgrade_required" && minVersion
			? ` — this client advertises ${COMMAND_CODE_CLIENT_VERSION}; the platform requires >= ${minVersion}`
			: "";
	return `${response.status} ${response.statusText}: ${suffix}${codeSuffix}${hint}`;
}

function createResponseError(
	model: Model<"command-code">,
	url: URL,
	response: Response,
	body: string,
): CommandCodeResponseError {
	const errorBody = parseErrorBody(body);
	return new CommandCodeResponseError(formatResponseError(response, body, errorBody), errorBody?.error?.code, {
		version: 1,
		provider: model.provider,
		model: model.id,
		url: url.toString(),
		status: response.status,
		statusText: response.statusText,
		error: errorBody?.error,
		body: errorBody ? undefined : truncateDiagnosticString(body),
		timestampMs: Date.now(),
	});
}

function createStreamError(
	model: Model<"command-code">,
	url: URL,
	wire: CommandCodeWireError,
): CommandCodeResponseError {
	return new CommandCodeResponseError(wire.message ?? "Command Code stream failed", wire.type, {
		version: 1,
		provider: model.provider,
		model: model.id,
		url: url.toString(),
		status: wire.statusCode,
		error: wire,
		timestampMs: Date.now(),
	});
}

function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function defaultEnvironment(): string {
	const proc = (globalThis as { process?: { platform?: string } }).process;
	return proc?.platform ?? "unknown";
}

/** Build the inert workspace-context block, defaulting to an empty description. */
function buildRequestConfig(overrides: Partial<CommandCodeRequestConfig> | undefined): CommandCodeRequestConfig {
	return {
		workingDir: "",
		date: new Date().toISOString(),
		environment: defaultEnvironment(),
		structure: [],
		isGitRepo: false,
		currentBranch: "",
		mainBranch: "",
		gitStatus: "",
		recentCommits: [],
		...overrides,
	};
}

/** Convert MyHarness messages into the platform's wire shape. */
export function toWireMessages(context: Context): CommandCodeWireMessage[] {
	const out: CommandCodeWireMessage[] = [];
	const toolNameById = new Map<string, string>();

	for (const message of context.messages) {
		if (message.role === "assistant") {
			const content: CommandCodeWirePart[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text) content.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					if (block.thinking) content.push({ type: "reasoning", text: block.thinking });
				} else if (block.type === "toolCall") {
					toolNameById.set(block.id, block.name);
					content.push({
						type: "tool-call",
						toolCallId: block.id,
						toolName: block.name,
						input: block.arguments,
					});
				}
			}
			if (content.length > 0) out.push({ role: "assistant", content });
			continue;
		}

		if (message.role === "toolResult") {
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			// A blank name fails server-side validation, so fall back to the name
			// recorded for this call id, then to a placeholder. An unknown-but-wrong
			// name still passes proto validation.
			const declaredName = message.toolName?.trim();
			out.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: message.toolCallId,
						toolName: toolNameById.get(message.toolCallId) ?? (declaredName ? declaredName : "unknown"),
						output: { type: message.isError ? "error-text" : "text", value: text },
					},
				],
			});
			continue;
		}

		const content: CommandCodeWirePart[] = [];
		if (typeof message.content === "string") {
			if (message.content) content.push({ type: "text", text: message.content });
		} else {
			for (const part of message.content) {
				if (part.type === "text") {
					if (part.text) content.push({ type: "text", text: part.text });
				} else {
					content.push({
						type: "image",
						image: `data:${part.mimeType};base64,${part.data}`,
						mimeType: part.mimeType,
					});
				}
			}
		}
		if (content.length > 0) out.push({ role: "user", content });
	}

	return out;
}

/** Convert MyHarness tools into the platform's `input_schema` shape. */
export function toWireTools(context: Context): { name: string; description: string; input_schema: unknown }[] {
	return (context.tools ?? []).map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

/** Map a MyHarness thinking level onto the platform's `reasoning_effort`. */
function resolveReasoningEffort(
	model: Model<"command-code">,
	reasoning: ThinkingLevel | undefined,
): string | undefined {
	// `ThinkingLevel` excludes "off"; an absent level means the caller wants no
	// explicit reasoning effort and the platform default applies.
	if (!reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning];
	if (mapped === null) return undefined;
	return mapped ?? reasoning;
}

/** Normalize a platform finish reason onto MyHarness stop reasons. */
export function normalizeStopReason(raw: string | undefined): AssistantMessage["stopReason"] {
	const value = (raw ?? "").toLowerCase();
	if (value === "tool_use" || value === "tool-calls" || value === "tool_calls" || value === "tool-call") {
		return "toolUse";
	}
	if (value === "length" || value === "max_tokens" || value === "max-tokens") return "length";
	if (value === "error" || value === "content-filter" || value === "content_filter") return "error";
	return "stop";
}

/** Translate a platform usage block into MyHarness usage (cost applied later). */
export function toUsage(wire: CommandCodeWireUsage | undefined): Usage {
	const input = wire?.inputTokens ?? 0;
	const output = wire?.outputTokens ?? 0;
	const cacheRead = wire?.inputTokenDetails?.cacheReadTokens ?? 0;
	const cacheWrite = wire?.inputTokenDetails?.cacheWriteTokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: wire?.outputTokenDetails?.reasoningTokens ?? wire?.reasoningTokens ?? 0,
		totalTokens: wire?.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Merge one continuation attempt's usage into the running total. */
function addUsage(target: Usage, next: Usage): void {
	target.input += next.input;
	target.output += next.output;
	target.cacheRead += next.cacheRead;
	target.cacheWrite += next.cacheWrite;
	target.reasoning = (target.reasoning ?? 0) + (next.reasoning ?? 0);
	target.totalTokens += next.totalTokens;
}

/**
 * Parse one NDJSON line. Tolerates a stray SSE `data:` prefix so the parser
 * survives a transport change, but the platform sends bare JSON objects.
 */
function parseLine(line: string): CommandCodeStreamEvent | undefined {
	const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
	if (!payload || payload === "[DONE]") return undefined;
	try {
		const parsed = JSON.parse(payload) as CommandCodeStreamEvent;
		return typeof parsed?.type === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Split an NDJSON byte stream into parsed events, across chunk boundaries. */
export async function* readCommandCodeEvents(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CommandCodeStreamEvent> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = "";

	const drain = (flush: boolean): CommandCodeStreamEvent[] => {
		const events: CommandCodeStreamEvent[] = [];
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) {
				const event = parseLine(line);
				if (event) events.push(event);
			}
			newline = buffer.indexOf("\n");
		}
		if (flush) {
			const line = buffer.trim();
			buffer = "";
			if (line) {
				const event = parseLine(line);
				if (event) events.push(event);
			}
		}
		return events;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");
			for (const event of drain(false)) yield event;
			if (done) break;
		}
		for (const event of drain(true)) yield event;
	} finally {
		reader.releaseLock();
	}
}

export interface CommandCodeEventConverter {
	convert(event: CommandCodeStreamEvent): AssistantMessageEvent | undefined;
	/** The accumulating assistant message; terminal events reference this object. */
	readonly message: AssistantMessage;
}

/**
 * Stateful translator from platform stream events to MyHarness stream events.
 *
 * Content ids are tracked so interleaved reasoning/text/tool blocks land at
 * stable content indices, including across `pause_turn` continuations. The
 * platform's own `start`/`start-step`/`finish*`/`provider-metadata` lines carry
 * no MyHarness event, so they convert to `undefined`; the caller emits `start`
 * once the response is known to be OK.
 */
export function createEventConverter(model: Model<"command-code">): CommandCodeEventConverter {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const indexById = new Map<string, number>();
	const toolJson = new Map<number, string>();

	const convert = (event: CommandCodeStreamEvent): AssistantMessageEvent | undefined => {
		switch (event.type) {
			case "reasoning-start": {
				const contentIndex = message.content.push({ type: "thinking", thinking: "" }) - 1;
				indexById.set(event.id, contentIndex);
				return { type: "thinking_start", contentIndex, partial: message };
			}
			case "reasoning-delta": {
				const contentIndex = indexById.get(event.id);
				if (contentIndex === undefined) return undefined;
				const block = message.content[contentIndex];
				if (block?.type !== "thinking") return undefined;
				block.thinking += event.text;
				return { type: "thinking_delta", contentIndex, delta: event.text, partial: message };
			}
			case "reasoning-end": {
				const contentIndex = indexById.get(event.id);
				if (contentIndex === undefined) return undefined;
				const block = message.content[contentIndex];
				if (block?.type !== "thinking") return undefined;
				return { type: "thinking_end", contentIndex, content: block.thinking, partial: message };
			}

			case "text-start": {
				const contentIndex = message.content.push({ type: "text", text: "" }) - 1;
				indexById.set(event.id, contentIndex);
				return { type: "text_start", contentIndex, partial: message };
			}
			case "text-delta": {
				const contentIndex = indexById.get(event.id);
				if (contentIndex === undefined) return undefined;
				const block = message.content[contentIndex];
				if (block?.type !== "text") return undefined;
				block.text += event.text;
				return { type: "text_delta", contentIndex, delta: event.text, partial: message };
			}
			case "text-end": {
				const contentIndex = indexById.get(event.id);
				if (contentIndex === undefined) return undefined;
				const block = message.content[contentIndex];
				if (block?.type !== "text") return undefined;
				return { type: "text_end", contentIndex, content: block.text, partial: message };
			}

			case "tool-input-start": {
				const contentIndex =
					message.content.push({ type: "toolCall", id: event.id, name: event.toolName, arguments: {} }) - 1;
				indexById.set(event.id, contentIndex);
				toolJson.set(contentIndex, "");
				return { type: "toolcall_start", contentIndex, partial: message };
			}
			case "tool-input-delta": {
				const contentIndex = indexById.get(event.id);
				if (contentIndex === undefined) return undefined;
				const json = `${toolJson.get(contentIndex) ?? ""}${event.delta}`;
				toolJson.set(contentIndex, json);
				const block = message.content[contentIndex];
				if (block?.type !== "toolCall") return undefined;
				block.arguments = parseStreamingJson<ToolCall["arguments"]>(json);
				return { type: "toolcall_delta", contentIndex, delta: event.delta, partial: message };
			}
			case "tool-input-end":
				// The terminal tool event is `tool-call`, which carries the authoritative
				// input; emitting `toolcall_end` here too would duplicate it.
				return undefined;

			case "tool-call": {
				// Authoritative final input; overrides any lossy streaming parse.
				let contentIndex = indexById.get(event.toolCallId);
				if (contentIndex === undefined) {
					contentIndex =
						message.content.push({
							type: "toolCall",
							id: event.toolCallId,
							name: event.toolName,
							arguments: {},
						}) - 1;
					indexById.set(event.toolCallId, contentIndex);
				}
				const block = message.content[contentIndex];
				if (block?.type !== "toolCall") return undefined;
				block.name = event.toolName;
				block.arguments = (event.input ?? {}) as ToolCall["arguments"];
				return { type: "toolcall_end", contentIndex, toolCall: block, partial: message };
			}

			default:
				return undefined;
		}
	};

	return { convert, message };
}

function createErrorEvent(model: Model<"command-code">, error: unknown, aborted: boolean): AssistantMessageEvent {
	const reason = aborted ? "aborted" : "error";
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: reason,
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};

	if (!aborted && error instanceof CommandCodeResponseError) {
		appendAssistantMessageDiagnostic(
			assistantMessage,
			createAssistantMessageDiagnostic("command_code_response_failure", error, error.diagnosticDetails),
		);
	}

	return { type: "error", reason, error: assistantMessage };
}

interface CommandCodeRequestBody {
	config: CommandCodeRequestConfig;
	memory: null;
	taste: null;
	skills: null;
	permissionMode: string;
	threadId?: string;
	promptCache: string;
	params: {
		model: string;
		messages: CommandCodeWireMessage[];
		tools: { name: string; description: string; input_schema: unknown }[];
		system: string;
		max_tokens: number;
		stream: true;
		temperature?: number;
		reasoning_effort?: string;
	};
}

/** Build the request envelope sent to `/alpha/generate`. */
export function buildRequestBody(
	model: Model<"command-code">,
	context: Context,
	options: CommandCodeOptions | undefined,
): CommandCodeRequestBody {
	const reasoningEffort = resolveReasoningEffort(model, options?.reasoning);
	// The platform drops a non-UUID thread id, so drop it here too rather than
	// sending a value the server will ignore.
	const threadIdCandidate = options?.threadId ?? options?.sessionId;
	const threadId = threadIdCandidate && UUID_PATTERN.test(threadIdCandidate) ? threadIdCandidate : undefined;
	return {
		config: buildRequestConfig(options?.config),
		memory: null,
		taste: null,
		skills: null,
		permissionMode: "standard",
		...(threadId ? { threadId } : {}),
		promptCache: "off",
		params: {
			model: model.id,
			messages: toWireMessages(context),
			tools: toWireTools(context),
			system: context.systemPrompt ?? "",
			max_tokens: options?.maxTokens ?? model.maxTokens ?? DEFAULT_MAX_TOKENS,
			stream: true,
			...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
			...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
		},
	};
}

export const stream: StreamFunction<"command-code", CommandCodeOptions> = (
	model: Model<"command-code">,
	context: Context,
	options?: CommandCodeOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();

	void (async () => {
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No Command Code credential provided for provider "${model.provider}"`);
			}

			const url = new URL(`${model.baseUrl.replace(/\/+$/u, "")}${COMMAND_CODE_GENERATE_ROUTE}`);
			const headers: Record<string, string> = {
				"content-type": "application/json",
				accept: "text/event-stream",
				[COMMAND_CODE_VERSION_HEADER]: options?.clientVersion ?? COMMAND_CODE_CLIENT_VERSION,
				authorization: `Bearer ${apiKey}`,
				...providerHeadersToRecord(options?.headers),
			};
			if (options?.zdr) headers[COMMAND_CODE_ZDR_HEADER] = "1";

			const body = buildRequestBody(model, context, options);
			const converter = createEventConverter(model);
			const accumulated = createEmptyUsage();
			let stopReason: AssistantMessage["stopReason"] = "stop";
			let sawToolCall = false;
			let startEmitted = false;

			for (let attempt = 0; attempt <= MAX_PAUSE_CONTINUATIONS; attempt++) {
				const payload = (await options?.onPayload?.(body, model)) ?? body;

				const response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: options?.signal,
				});

				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

				if (!response.ok) {
					const responseBody = await response.text();
					throw createResponseError(model, url, response, responseBody);
				}
				if (!response.body) {
					throw new Error(`${model.provider} response has no body`);
				}

				if (!startEmitted) {
					startEmitted = true;
					eventStream.push({ type: "start", partial: converter.message });
				}

				const attemptUsage = createEmptyUsage();
				let rawFinishReason: string | undefined;

				for await (const wireEvent of readCommandCodeEvents(response.body)) {
					if (wireEvent.type === "finish-step" || wireEvent.type === "finish") {
						rawFinishReason = wireEvent.rawFinishReason ?? wireEvent.finishReason ?? rawFinishReason;
						const usage = wireEvent.type === "finish" ? wireEvent.totalUsage : wireEvent.usage;
						if (usage) {
							if (wireEvent.type === "finish") Object.assign(attemptUsage, toUsage(usage));
							else addUsage(attemptUsage, toUsage(usage));
						}
						continue;
					}
					if (wireEvent.type === "error") {
						eventStream.push(
							createErrorEvent(model, createStreamError(model, url, wireEvent.error ?? {}), false),
						);
						return;
					}
					if (wireEvent.type === "tool-call") sawToolCall = true;

					const converted = converter.convert(wireEvent);
					if (converted) eventStream.push(converted);
				}

				addUsage(accumulated, attemptUsage);
				stopReason = normalizeStopReason(rawFinishReason);
				if (rawFinishReason !== "pause_turn" || attempt === MAX_PAUSE_CONTINUATIONS) break;

				// Continuation: replay the assistant turn produced so far and retry. The
				// converter keeps allocating fresh content indices, so streamed output
				// stays non-duplicating.
				const assistantContent: CommandCodeWirePart[] = [];
				for (const block of converter.message.content) {
					if (block.type === "text" && block.text) assistantContent.push({ type: "text", text: block.text });
					else if (block.type === "thinking" && block.thinking)
						assistantContent.push({ type: "reasoning", text: block.thinking });
					else if (block.type === "toolCall")
						assistantContent.push({
							type: "tool-call",
							toolCallId: block.id,
							toolName: block.name,
							input: block.arguments,
						});
				}
				if (assistantContent.length === 0) break;
				body.params.messages.push({ role: "assistant", content: assistantContent });
			}

			// A tool call with a "stop" finish reason still requires the caller to run
			// the tool, so surface it as toolUse.
			const message = converter.message;
			message.stopReason = sawToolCall && stopReason === "stop" ? "toolUse" : stopReason;
			Object.assign(message.usage, accumulated);
			calculateCost(model, message.usage);

			eventStream.push({
				type: "done",
				reason: message.stopReason as "stop" | "length" | "toolUse",
				message,
			});
		} catch (error) {
			eventStream.push(createErrorEvent(model, error, options?.signal?.aborted ?? false));
		}
	})();

	return eventStream;
};

export const streamSimple: StreamFunction<"command-code", SimpleStreamOptions> = (
	model: Model<"command-code">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const extra = options as CommandCodeOptions | undefined;
	return stream(model, context, {
		...options,
		reasoning: options?.reasoning,
		config: extra?.config,
		clientVersion: extra?.clientVersion,
		zdr: extra?.zdr,
		threadId: extra?.threadId,
	});
};
