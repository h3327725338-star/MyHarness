/**
 * Third-priority thinking-effort detection: real minimal requests to the model.
 *
 * Order of trust (see `official-thinking.ts` for the first two): the endpoint's own model metadata, then the
 * provider's documented rules for its own API host, and only when neither settles a level, this probe.
 *
 * A probe sends one tiny request per level (16 output tokens) with the effort parameter of the model's own API
 * protocol (`reasoning_effort`, `reasoning.effort`, `output_config.effort`, `thinkingConfig.thinkingLevel`). What the
 * server answers is the only evidence used; the quality or amount of reasoning is never looked at.
 *
 * A 2xx answer alone does not prove a level works: many compatible servers silently drop parameters they do not know.
 * So every probe first sends a canary with an invalid effort value. A server that rejects the canary validates the
 * parameter, so a 2xx for a real level means the level is applied (`supported`). A server that accepts the canary
 * ignores the parameter, so a 2xx proves nothing (`unverified`). Only a rejection that names the effort parameter
 * counts as `unsupported`; rate limits, quota, auth, timeouts, 5xx and every other failure are `unknown`.
 */

import type { ThinkingLevel, ThinkingLevelMap } from "@myharness/ai";

/** `supported` and `unsupported` are confirmed; `unverified` = accepted but not shown to be applied; `unknown` = undecided. */
export type ThinkingLevelStatus = "supported" | "unsupported" | "unverified" | "unknown";
export type ThinkingLevelStatuses = Partial<Record<ThinkingLevel, ThinkingLevelStatus>>;

export const PROBE_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EXTRA_LEVELS = new Set<ThinkingLevel>(["xhigh", "max"]);

/** Statuses a probe can be run for: every level that has no status yet or is still `unknown`. */
export function unresolvedLevels(statuses: ThinkingLevelStatuses | undefined): ThinkingLevel[] {
	return PROBE_LEVELS.filter((level) => !statuses?.[level] || statuses[level] === "unknown");
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
		if (!status || status === "unknown") continue;
		if (isConfirmed(status) || !isConfirmed(merged[level])) merged[level] = status;
	}
	return merged;
}

/**
 * Applies probe statuses to a thinkingLevelMap. Only confirmed results change existing entries; `unsupported` marks a
 * standard level `null` (xhigh / max are simply not enabled), `supported` re-enables it. For a model with no map yet,
 * `xhigh` / `max` that are not confirmed unsupported are enabled too, because the runtime hides them without an entry
 * and an unconfirmed level must stay selectable.
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
		} else if (status === "supported" || (options.enableUnconfirmedExtras && extra && status !== "unknown")) {
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
	fetchImpl?: typeof fetch;
}

const INVALID_EFFORT = "myharness_probe_invalid";
const PROBE_MAX_TOKENS = 16;
/** Names of the effort parameter in error messages of the supported protocols. */
const EFFORT_PARAMETER =
	/reasoning_effort|reasoning\.effort|reasoning effort|output_config|\beffort\b|thinking_?level|thinking_?config/iu;
const TOKEN_PARAMETER = /max_completion_tokens|max_tokens|max_output_tokens/iu;

type Outcome = "ok" | "rejected" | "other";
interface Reply {
	outcome: Outcome;
	status?: number;
	text: string;
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

function buildRequest(
	options: ProbeThinkingOptions,
	effort: string,
	tokenField: "max_tokens" | "max_completion_tokens",
): ProbeRequest {
	const base = trimSlash(options.baseUrl);
	switch (options.api) {
		case "openai-completions":
			return {
				url: `${base}/chat/completions`,
				body: {
					model: options.modelId,
					messages: [{ role: "user", content: "1" }],
					[tokenField]: PROBE_MAX_TOKENS,
					reasoning_effort: effort,
				},
			};
		case "openai-responses":
			return {
				url: `${base}/responses`,
				body: {
					model: options.modelId,
					input: "1",
					max_output_tokens: PROBE_MAX_TOKENS,
					reasoning: { effort },
					store: false,
				},
			};
		case "anthropic-messages":
			return {
				url: `${base}${hasVersionSegment(options.baseUrl) ? "" : "/v1"}/messages`,
				body: {
					model: options.modelId,
					max_tokens: PROBE_MAX_TOKENS,
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
						maxOutputTokens: PROBE_MAX_TOKENS,
						thinkingConfig: { thinkingLevel: effort.toUpperCase() },
					},
				},
			};
		}
	}
}

async function send(options: ProbeThinkingOptions, request: ProbeRequest): Promise<Reply> {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const headers = new Headers(options.headers);
	headers.set("Content-Type", "application/json");
	try {
		const response = await (options.fetchImpl ?? fetch)(request.url, {
			method: "POST",
			headers,
			body: JSON.stringify(request.body),
			signal,
		});
		const text = await response.text().catch(() => "");
		if (response.ok) return { outcome: "ok", status: response.status, text };
		// Only a client-side validation error can be a statement about the parameter; every other status (auth, quota,
		// rate limit, model not found, server error) says nothing about the effort level.
		if ((response.status === 400 || response.status === 422) && EFFORT_PARAMETER.test(text)) {
			return { outcome: "rejected", status: response.status, text };
		}
		return { outcome: "other", status: response.status, text };
	} catch {
		return { outcome: "other", text: "" };
	}
}

/** Runs one request; retries once with the other output-token field when the server rejects the one used. */
function requestFor(
	options: ProbeThinkingOptions,
	effort: string,
	state: { tokenField: "max_tokens" | "max_completion_tokens" },
): Promise<Reply> {
	const run = async (): Promise<Reply> => send(options, buildRequest(options, effort, state.tokenField));
	return run().then(async (reply) => {
		if (options.api !== "openai-completions" || reply.outcome === "ok") return reply;
		// The token field is not the effort parameter: a message about it (and not about effort) means the field name.
		if (reply.status === 400 && TOKEN_PARAMETER.test(reply.text) && !EFFORT_PARAMETER.test(reply.text)) {
			state.tokenField = state.tokenField === "max_tokens" ? "max_completion_tokens" : "max_tokens";
			return run();
		}
		return reply;
	});
}

/** Answers that say nothing about the parameter and make further requests pointless (or costly). */
function isBlocking(reply: Reply): boolean {
	return (
		reply.outcome === "other" &&
		(reply.status === undefined || reply.status >= 500 || ![400, 422].includes(reply.status))
	);
}

/**
 * Probes the given levels of one model. Returns a status for every requested level; never throws. A request that
 * cannot be evaluated leaves its level `unknown`, so callers must not treat `unknown` as "not supported".
 */
export async function probeThinkingLevels(options: ProbeThinkingOptions): Promise<ThinkingLevelStatuses> {
	const levels = options.levels ?? PROBE_LEVELS;
	const result: ThinkingLevelStatuses = {};
	if (levels.length === 0) return result;
	let host = "";
	try {
		host = new URL(options.baseUrl).hostname.toLowerCase();
	} catch {
		// The request URLs cannot be built either; every level stays unknown below.
	}
	const state: { tokenField: "max_tokens" | "max_completion_tokens" } = {
		tokenField: host === "api.openai.com" ? "max_completion_tokens" : "max_tokens",
	};

	const canary = await requestFor(options, INVALID_EFFORT, state);
	if (isBlocking(canary) || options.signal?.aborted) {
		for (const level of levels) result[level] = "unknown";
		return result;
	}
	// Only a server that turns a bogus value down validates the parameter and so can confirm a real one.
	const validates = canary.outcome === "rejected";

	await Promise.all(
		levels.map(async (level) => {
			const value = options.levelValues?.[level];
			const reply = await requestFor(options, typeof value === "string" ? value : level, state);
			if (reply.outcome === "rejected") result[level] = "unsupported";
			else if (reply.outcome === "ok") result[level] = validates ? "supported" : "unverified";
			else result[level] = "unknown";
		}),
	);
	return result;
}
