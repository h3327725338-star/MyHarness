/**
 * Thinking-effort detection by real minimal requests to one model.
 *
 * The probe is given a concrete Model ID and asks the service itself: one tiny request per effort level (16 output
 * tokens) with the effort parameter of the model's own API protocol (`reasoning_effort`, `reasoning.effort`,
 * `output_config.effort`, `thinkingConfig.thinkingLevel`). Nothing is inferred from the model's name, from a table of
 * known models or from the result of another level; a model MyHarness has never seen is probed like any other.
 *
 * Every level is decided on its own:
 * - the request succeeds                                   -> `supported`
 * - the service says the effort parameter or this value is not supported -> `unsupported`
 * - anything else (timeout, 429, 5xx, network failure, broken connection, an answer that cannot be read, a rejection
 *   that does not name the effort)                         -> `unknown`
 *
 * An `unknown` answer is tried again, up to three more times (four attempts per level). The first success settles the
 * level as `supported`, an explicit rejection settles it as `unsupported`; a level still undecided after the last
 * attempt stays `unknown`. `unknown` never hides a level and never replaces what is already configured.
 */

import type { ThinkingLevel, ThinkingLevelMap } from "@myharness/ai";

/**
 * `supported` and `unsupported` are confirmed, `unknown` is undecided. `unverified` is no longer produced; it is only
 * read from models.json written by earlier versions and treated as undecided.
 */
export type ThinkingLevelStatus = "supported" | "unsupported" | "unverified" | "unknown";
export type ThinkingLevelStatuses = Partial<Record<ThinkingLevel, ThinkingLevelStatus>>;

export const PROBE_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EXTRA_LEVELS = new Set<ThinkingLevel>(["xhigh", "max"]);

/**
 * Levels worth probing: everything a real successful request has not confirmed yet. A stored `unsupported` is asked
 * again too (the service may have changed, and an explicit rejection costs nothing).
 */
export function unresolvedLevels(statuses: ThinkingLevelStatuses | undefined): ThinkingLevel[] {
	return PROBE_LEVELS.filter((level) => statuses?.[level] !== "supported");
}

const isConfirmed = (status: ThinkingLevelStatus | undefined): boolean =>
	status === "supported" || status === "unsupported";

/**
 * Combines an earlier status record with a new one. A confirmed result always wins; a weaker result never replaces a
 * confirmed one, and `unknown` never replaces anything.
 */
export function mergeLevelStatuses(
	previous: ThinkingLevelStatuses | undefined,
	next: ThinkingLevelStatuses | undefined,
): ThinkingLevelStatuses {
	const merged: ThinkingLevelStatuses = { ...previous };
	for (const level of PROBE_LEVELS) {
		const status = next?.[level];
		if (!status) continue;
		if (status === "unknown") {
			if (!merged[level]) merged[level] = status;
			continue;
		}
		if (isConfirmed(status) || !isConfirmed(merged[level])) merged[level] = status;
	}
	return merged;
}

/**
 * Applies probe statuses to a thinkingLevelMap. Only confirmed results change existing entries; `unsupported` marks a
 * standard level `null` (xhigh / max are simply not enabled), `supported` re-enables it. For a model with no map yet,
 * `enableUnconfirmedExtras` also enables `xhigh` / `max` that are not confirmed unsupported: the runtime hides them
 * without an entry, and a level nobody could check must stay selectable.
 */
export function applyStatusesToMap(
	current: ThinkingLevelMap | undefined,
	statuses: ThinkingLevelStatuses,
	options: { enableUnconfirmedExtras?: boolean } = {},
): ThinkingLevelMap | undefined {
	const map: ThinkingLevelMap = { ...current };
	for (const level of PROBE_LEVELS) {
		const status = statuses[level];
		if (!status) continue;
		const extra = EXTRA_LEVELS.has(level);
		if (status === "unsupported") {
			if (extra) delete map[level];
			else map[level] = null;
		} else if (status === "supported" || (options.enableUnconfirmedExtras && extra)) {
			if (typeof map[level] !== "string") {
				if (extra) map[level] = level;
				else delete map[level];
			}
		}
	}
	return Object.keys(map).length > 0 || current ? map : undefined;
}

export type ProbeApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export function isProbeApi(api: string): api is ProbeApi {
	return (
		api === "openai-completions" ||
		api === "openai-responses" ||
		api === "anthropic-messages" ||
		api === "google-generative-ai"
	);
}

export interface ProbeThinkingOptions {
	api: ProbeApi;
	baseUrl: string;
	modelId: string;
	/** Complete request headers, authentication included. */
	headers: Headers;
	/** Only used by the Google API, which takes the key as a query parameter when no header carries it. */
	googleApiKey?: string;
	/** Levels to probe; default is every level. */
	levels?: readonly ThinkingLevel[];
	/** Effort value sent for a level when the model names it differently (`thinkingLevelMap`). */
	levelValues?: ThinkingLevelMap;
	signal?: AbortSignal;
	/** Per-request timeout. */
	timeoutMs?: number;
	/** Waits before the 2nd, 3rd and 4th attempt of a level that is still undecided. */
	retryDelaysMs?: readonly number[];
	/** Levels probed at the same time (default 2; relays rate-limit bursts). */
	concurrency?: number;
	fetchImpl?: typeof fetch;
}

/** Extra attempts for a level whose answer could not be evaluated: four attempts in total. */
export const PROBE_EXTRA_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [500, 1500, 3000] as const;
const PROBE_MAX_TOKENS = 16;
/** Used once a service says 16 output tokens leave no room for reasoning. */
const PROBE_ROOMY_MAX_TOKENS = 1024;
/** Names of the effort parameter in error messages of the supported protocols. */
const EFFORT_PARAMETER =
	/reasoning_effort|reasoning\.effort|reasoning effort|output_config|\beffort\b|thinking_?level|thinking_?config/iu;
/** Words by which a service turns a parameter or a value down. */
const REJECTION_WORDS =
	/invalid|unsupported|not supported|n[o']t support|unknown|unrecognized|unexpected|not allowed|not permitted|not a valid|must be|should be|expected|one of|不支持|无效|不合法/iu;
const TOKEN_WORDS = /token|length|too small|too low|budget/iu;
const TOKEN_PARAMETER = /max_completion_tokens|max_tokens|max_output_tokens|maxOutputTokens/iu;

type TokenField = "max_tokens" | "max_completion_tokens";
interface ProbeState {
	tokenField: TokenField;
	maxTokens: number;
}

/** `rejected` = the service turned the effort down explicitly; `unknown` = nothing can be concluded. */
type Outcome = "ok" | "rejected" | "unknown";
interface Reply {
	outcome: Outcome;
	status?: number;
	/** The service's own error wording (message, parameter name), without envelope fields such as the error type. */
	message: string;
	/** Retrying cannot change the answer (the credentials were refused). */
	permanent?: boolean;
	retryAfterMs?: number;
}

function trimSlash(value: string): string {
	return value.replace(/\/+$/u, "");
}

function hasVersionSegment(baseUrl: string): boolean {
	try {
		return /\/v\d+(?:beta)?$/u.test(trimSlash(new URL(baseUrl).pathname));
	} catch {
		return false;
	}
}

interface ProbeRequest {
	url: string;
	body: Record<string, unknown>;
}

function buildRequest(options: ProbeThinkingOptions, effort: string, state: ProbeState): ProbeRequest {
	const base = trimSlash(options.baseUrl);
	switch (options.api) {
		case "openai-completions":
			return {
				url: `${base}/chat/completions`,
				body: {
					model: options.modelId,
					messages: [{ role: "user", content: "1" }],
					[state.tokenField]: state.maxTokens,
					reasoning_effort: effort,
				},
			};
		case "openai-responses":
			return {
				url: `${base}/responses`,
				body: {
					model: options.modelId,
					input: "1",
					max_output_tokens: state.maxTokens,
					reasoning: { effort },
					store: false,
				},
			};
		case "anthropic-messages":
			return {
				url: `${base}${hasVersionSegment(options.baseUrl) ? "" : "/v1"}/messages`,
				body: {
					model: options.modelId,
					max_tokens: state.maxTokens,
					messages: [{ role: "user", content: "1" }],
					output_config: { effort },
				},
			};
		case "google-generative-ai": {
			const root = hasVersionSegment(options.baseUrl) ? base : `${base}/v1beta`;
			const url = new URL(`${root}/models/${encodeURIComponent(options.modelId)}:generateContent`);
			if (options.googleApiKey) url.searchParams.set("key", options.googleApiKey);
			return {
				url: url.toString(),
				body: {
					contents: [{ role: "user", parts: [{ text: "1" }] }],
					generationConfig: {
						maxOutputTokens: state.maxTokens,
						thinkingConfig: { thinkingLevel: effort.toUpperCase() },
					},
				},
			};
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the service wrote about the failure: message texts and the parameter it names. Envelope fields such as
 * `type: "invalid_request_error"` are left out, because they would make every error look like a rejection.
 */
function errorWording(parsed: unknown, raw: string): string {
	if (!isRecord(parsed)) return raw;
	const parts: string[] = [];
	const collect = (value: unknown, depth: number): void => {
		if (typeof value === "string") parts.push(value);
		else if (isRecord(value) && depth < 3) {
			for (const key of ["message", "msg", "detail", "details", "param", "error", "error_description", "reason"]) {
				collect(value[key], depth + 1);
			}
		} else if (Array.isArray(value) && depth < 3) {
			for (const entry of value) collect(entry, depth + 1);
		}
	};
	collect(parsed, 0);
	return parts.length > 0 ? parts.join("\n") : raw;
}

/** The service says, in its own words, that the effort parameter or this effort value is not supported. */
function rejectsEffort(message: string, effort: string): boolean {
	if (!REJECTION_WORDS.test(message)) return false;
	if (EFFORT_PARAMETER.test(message)) return true;
	// A complaint about the output-token limit is not about the effort, whatever values it quotes.
	if (TOKEN_PARAMETER.test(message)) return false;
	const quoted = new RegExp(`["'\`]${effort.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["'\`]`, "iu");
	return quoted.test(message);
}

async function send(options: ProbeThinkingOptions, request: ProbeRequest, effort: string): Promise<Reply> {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const headers = new Headers(options.headers);
	headers.set("Content-Type", "application/json");
	let response: Response;
	let text: string;
	try {
		response = await (options.fetchImpl ?? fetch)(request.url, {
			method: "POST",
			headers,
			body: JSON.stringify(request.body),
			signal,
		});
		// A connection that breaks while the answer is read is as undecided as one that never opened.
		text = await response.text();
	} catch {
		return { outcome: "unknown", message: "" };
	}
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : undefined;
	} catch {
		parsed = undefined;
	}
	const failed = !response.ok || (isRecord(parsed) && Boolean(parsed.error));
	if (!failed) {
		// A success is an answer of the API itself; a gateway page or an empty reply proves nothing.
		return { outcome: isRecord(parsed) ? "ok" : "unknown", status: response.status, message: "" };
	}
	const message = errorWording(parsed, text);
	const status = response.status;
	const retryAfter = Number(response.headers.get("retry-after"));
	const reply: Reply = {
		outcome: "unknown",
		status,
		message,
		permanent: status === 401 || status === 403,
		...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: Math.min(retryAfter * 1000, 10_000) } : {}),
	};
	// Authentication, permission and rate-limit answers say nothing about the effort, whatever their text mentions.
	if (status === 401 || status === 403 || status === 429) return reply;
	if (rejectsEffort(message, effort)) reply.outcome = "rejected";
	return reply;
}

/**
 * One attempt for one level. A complaint about the output-token field or about too little room for reasoning is not an
 * answer about the effort: the request is adjusted and sent again within the same attempt.
 */
async function attempt(options: ProbeThinkingOptions, effort: string, state: ProbeState): Promise<Reply> {
	let sentField = state.tokenField;
	let sentTokens = state.maxTokens;
	let reply = await send(options, buildRequest(options, effort, state), effort);
	for (let adjusted = 0; adjusted < 2 && reply.outcome === "unknown" && reply.status === 400; adjusted++) {
		if (options.signal?.aborted) break;
		const wrongField =
			options.api === "openai-completions" &&
			TOKEN_PARAMETER.test(reply.message) &&
			/unsupported|not supported|unknown|unrecognized|instead|use /iu.test(reply.message);
		if (wrongField) {
			// Another level may have switched the field already; only switch away from the one this request used.
			if (state.tokenField === sentField) {
				state.tokenField = sentField === "max_tokens" ? "max_completion_tokens" : "max_tokens";
			}
		} else if (TOKEN_WORDS.test(reply.message) && sentTokens < PROBE_ROOMY_MAX_TOKENS) {
			state.maxTokens = PROBE_ROOMY_MAX_TOKENS;
		} else break;
		sentField = state.tokenField;
		sentTokens = state.maxTokens;
		reply = await send(options, buildRequest(options, effort, state), effort);
	}
	return reply;
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

async function probeLevel(
	options: ProbeThinkingOptions,
	level: ThinkingLevel,
	state: ProbeState,
): Promise<ThinkingLevelStatus> {
	const value = options.levelValues?.[level];
	const effort = typeof value === "string" ? value : level;
	const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	for (let tries = 0; tries <= PROBE_EXTRA_ATTEMPTS; tries++) {
		if (options.signal?.aborted) return "unknown";
		const reply = await attempt(options, effort, state);
		if (reply.outcome === "ok") return "supported";
		if (reply.outcome === "rejected") return "unsupported";
		if (reply.permanent || tries === PROBE_EXTRA_ATTEMPTS) return "unknown";
		await wait(reply.retryAfterMs ?? delays[Math.min(tries, delays.length - 1)] ?? 0, options.signal);
	}
	return "unknown";
}

/**
 * Probes the given levels of one model, each on its own. Returns a status for every requested level; never throws. A
 * level that cannot be evaluated stays `unknown`, so callers must not treat `unknown` as "not supported".
 */
export async function probeThinkingLevels(options: ProbeThinkingOptions): Promise<ThinkingLevelStatuses> {
	const levels = [...(options.levels ?? PROBE_LEVELS)];
	const result: ThinkingLevelStatuses = {};
	if (levels.length === 0) return result;
	let host = "";
	try {
		host = new URL(options.baseUrl).hostname.toLowerCase();
	} catch {
		// The request URLs cannot be built either: there is nothing to ask, every level stays unknown.
		for (const level of levels) result[level] = "unknown";
		return result;
	}
	const state: ProbeState = {
		tokenField: host === "api.openai.com" ? "max_completion_tokens" : "max_tokens",
		maxTokens: PROBE_MAX_TOKENS,
	};
	const queue = [...levels];
	const worker = async (): Promise<void> => {
		for (let level = queue.shift(); level; level = queue.shift()) {
			result[level] = await probeLevel(options, level, state);
		}
	};
	const workers = Math.max(1, Math.min(options.concurrency ?? 2, levels.length));
	await Promise.all(Array.from({ length: workers }, () => worker()));
	// Keep the answer in level order, whatever order the requests finished in.
	return Object.fromEntries(levels.map((level) => [level, result[level] ?? "unknown"]));
}
