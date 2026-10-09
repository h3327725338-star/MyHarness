import type { AssistantMessageDiagnostic } from "./diagnostics.ts";
import { withProviderDispatcher } from "./provider-dispatcher.ts";

/**
 * The one list of reasons a provider request failed, shared by the retry policy and the UI.
 * Network categories come from the error's `code` found anywhere in its `cause` chain, never from message text.
 */
export type ProviderErrorCategory =
	| "connect_timeout"
	| "connect_failed"
	| "first_byte_timeout"
	| "stream_idle_timeout"
	| "disconnect"
	| "rate_limited"
	| "upstream_overloaded"
	| "other";

export const PROVIDER_ERROR_CATEGORIES: readonly ProviderErrorCategory[] = [
	"connect_timeout",
	"connect_failed",
	"first_byte_timeout",
	"stream_idle_timeout",
	"disconnect",
	"rate_limited",
	"upstream_overloaded",
	"other",
];

/** Categories that mean the network or the gateway failed, not the model request itself. */
export const NETWORK_ERROR_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set<ProviderErrorCategory>([
	"connect_timeout",
	"connect_failed",
	"first_byte_timeout",
	"stream_idle_timeout",
	"disconnect",
]);

export function isNetworkErrorCategory(category: ProviderErrorCategory | undefined): boolean {
	return category !== undefined && NETWORK_ERROR_CATEGORIES.has(category);
}

export interface ProviderFailureInfo {
	category: ProviderErrorCategory;
	/** `code` of the error that decided the category (e.g. UND_ERR_BODY_TIMEOUT), when there is one. */
	causeCode?: string;
	/** Message of that error, or of the innermost cause when no code decided. */
	causeMessage?: string;
	status?: number;
	/** The response headers had arrived before the failure. */
	headersReceived: boolean;
}

export const PROVIDER_FAILURE_DIAGNOSTIC = "provider_failure";

const CONNECT_TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT"]);
const FIRST_BYTE_TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT"]);
const STREAM_IDLE_TIMEOUT_CODES = new Set(["UND_ERR_BODY_TIMEOUT"]);
const DISCONNECT_CODES = new Set([
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	"UND_ERR_DESTROYED",
	"ECONNRESET",
	"ECONNABORTED",
	"EPIPE",
]);
const CONNECT_FAILED_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENETDOWN",
	"EADDRNOTAVAIL",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"CERT_HAS_EXPIRED",
	"UND_ERR_PRX_TLS",
]);
const OVERLOADED_STATUSES = new Set([503, 529]);
const MAX_CAUSE_DEPTH = 8;
const MAX_CAUSE_MESSAGE_CHARS = 240;

interface ErrorShape {
	name?: unknown;
	message?: unknown;
	code?: unknown;
	syscall?: unknown;
	status?: unknown;
	statusCode?: unknown;
	error?: unknown;
	cause?: unknown;
	errors?: unknown;
}

/** The error followed by everything under `cause` / `errors` (AggregateError), outermost first. */
function causeChain(error: unknown): ErrorShape[] {
	const chain: ErrorShape[] = [];
	const seen = new Set<unknown>();
	const queue: unknown[] = [error];
	while (queue.length > 0 && chain.length < MAX_CAUSE_DEPTH * 2) {
		const current = queue.shift();
		if (typeof current !== "object" || current === null || seen.has(current)) continue;
		seen.add(current);
		const shape = current as ErrorShape;
		chain.push(shape);
		if (shape.cause !== undefined) queue.push(shape.cause);
		if (Array.isArray(shape.errors)) queue.push(...shape.errors);
	}
	return chain;
}

function codeOf(error: ErrorShape): string | undefined {
	return typeof error.code === "string" && error.code.length > 0 ? error.code : undefined;
}

function messageOf(error: ErrorShape): string | undefined {
	return typeof error.message === "string" && error.message.length > 0
		? error.message.slice(0, MAX_CAUSE_MESSAGE_CHARS)
		: undefined;
}

function statusOf(chain: ErrorShape[]): number | undefined {
	for (const error of chain) {
		if (typeof error.status === "number") return error.status;
		if (typeof error.statusCode === "number") return error.statusCode;
	}
	return undefined;
}

/** `type` / `code` fields of a parsed provider error body (not its message text). */
function bodyTypes(chain: ErrorShape[]): string[] {
	const types: string[] = [];
	for (const error of chain) {
		const body = error.error;
		if (typeof body !== "object" || body === null) continue;
		const { type, code } = body as { type?: unknown; code?: unknown };
		if (typeof type === "string") types.push(type);
		if (typeof code === "string") types.push(code);
	}
	return types;
}

/**
 * The SDKs' own request timer (OpenAI/Anthropic "Request timed out.") and aborted fetches carry no network code.
 * They are recognised by class or error name; the SDK timer only runs until the response headers arrive.
 */
function isSdkTimeout(chain: ErrorShape[]): boolean {
	return chain.some((error) => {
		const name = typeof error.name === "string" ? error.name : "";
		const className = (error as { constructor?: { name?: string } }).constructor?.name ?? "";
		return (
			name === "AbortError" ||
			name === "TimeoutError" ||
			className === "APIConnectionTimeoutError" ||
			messageOf(error) === "Request timed out."
		);
	});
}

/**
 * Classify a failed provider request.
 * Order: HTTP limits first (the server answered), then network codes found down the `cause` chain, then the SDK's own
 * timeout (headers not yet received → first byte, otherwise stream idle). Anything else is `other`.
 */
export function classifyProviderError(
	error: unknown,
	context: { headersReceived?: boolean } = {},
): ProviderFailureInfo {
	const headersReceived = context.headersReceived === true;
	const chain = causeChain(error);
	const status = statusOf(chain);
	const innermost = chain.at(-1);
	const base = { status, headersReceived };

	const types = bodyTypes(chain);
	if (status === 429 || types.some((type) => type === "rate_limit_exceeded" || type === "rate_limit_error")) {
		return { category: "rate_limited", ...base, causeMessage: messageOf(chain[0] ?? {}) };
	}
	if ((status !== undefined && OVERLOADED_STATUSES.has(status)) || types.includes("overloaded_error")) {
		return { category: "upstream_overloaded", ...base, causeMessage: messageOf(chain[0] ?? {}) };
	}

	for (const entry of chain) {
		const code = codeOf(entry);
		if (code === undefined) continue;
		let category: ProviderErrorCategory | undefined;
		if (CONNECT_TIMEOUT_CODES.has(code) || (code === "ETIMEDOUT" && entry.syscall === "connect")) {
			category = "connect_timeout";
		} else if (FIRST_BYTE_TIMEOUT_CODES.has(code)) category = "first_byte_timeout";
		else if (STREAM_IDLE_TIMEOUT_CODES.has(code)) category = "stream_idle_timeout";
		else if (DISCONNECT_CODES.has(code)) category = "disconnect";
		else if (CONNECT_FAILED_CODES.has(code)) category = "connect_failed";
		if (category) return { category, causeCode: code, causeMessage: messageOf(entry), ...base };
	}

	if (isSdkTimeout(chain)) {
		return {
			category: headersReceived ? "stream_idle_timeout" : "first_byte_timeout",
			causeMessage: messageOf(chain[0] ?? {}),
			...base,
		};
	}
	return {
		category: "other",
		causeCode: innermost ? codeOf(innermost) : undefined,
		causeMessage: innermost ? messageOf(innermost) : undefined,
		...base,
	};
}

/** Attach the classification to a failed assistant message as a diagnostic. */
export function recordProviderFailure(
	message: { diagnostics?: AssistantMessageDiagnostic[] },
	error: unknown,
	context: { headersReceived?: boolean } = {},
): ProviderFailureInfo {
	const info = classifyProviderError(error, context);
	message.diagnostics = [
		...(message.diagnostics ?? []).filter((item) => item.type !== PROVIDER_FAILURE_DIAGNOSTIC),
		{
			type: PROVIDER_FAILURE_DIAGNOSTIC,
			timestamp: Date.now(),
			details: {
				category: info.category,
				causeCode: info.causeCode,
				causeMessage: info.causeMessage,
				status: info.status,
				headersReceived: info.headersReceived,
			},
		},
	];
	return info;
}

/** The classification recorded on a failed assistant message, if its provider layer recorded one. */
export function getProviderFailure(message: {
	diagnostics?: AssistantMessageDiagnostic[];
}): ProviderFailureInfo | undefined {
	const entry = message.diagnostics?.find((item) => item.type === PROVIDER_FAILURE_DIAGNOSTIC);
	const details = entry?.details;
	if (!details) return undefined;
	const category = details.category as ProviderErrorCategory;
	if (!PROVIDER_ERROR_CATEGORIES.includes(category)) return undefined;
	return {
		category,
		causeCode: typeof details.causeCode === "string" ? details.causeCode : undefined,
		causeMessage: typeof details.causeMessage === "string" ? details.causeMessage : undefined,
		status: typeof details.status === "number" ? details.status : undefined,
		headersReceived: details.headersReceived === true,
	};
}

export interface FetchErrorCapture {
	/** Drop-in `fetch` for an SDK client that remembers the error of a failed fetch. */
	fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	/** The error the last fetch threw, with its `cause` chain, before the SDK wrapped or replaced it. */
	readonly error: unknown;
}

/**
 * The OpenAI SDK replaces any fetch error whose text mentions "time out" (undici's "Connect Timeout Error" and
 * "Headers Timeout Error" do) with a bare `APIConnectionTimeoutError` that has no `cause`, so the `code` that tells the
 * limits apart is lost. This keeps the original error so the failure is classified from it, not from the replacement.
 * A fetch that succeeds clears it, so a later HTTP error is never blamed on an earlier retry's network error.
 * When `provider` is given, its dispatcher (see `provider-dispatcher.ts`) is used for the request.
 */
export function captureFetchErrors(provider?: string): FetchErrorCapture {
	let captured: unknown;
	return {
		get error() {
			return captured;
		},
		async fetch(input, init) {
			try {
				const response = await globalThis.fetch(input, withProviderDispatcher(provider, init));
				captured = undefined;
				return response;
			} catch (error) {
				captured = error;
				throw error;
			}
		},
	};
}
