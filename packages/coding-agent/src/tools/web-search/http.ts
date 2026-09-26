import { pipeline, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { request } from "undici";
import { abortError, WebSearchError } from "./errors.ts";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Plain HTTP GET/POST through undici's global dispatcher (so proxy settings still
 * apply), exposed as a fetch-style function. It deliberately avoids WHATWG fetch:
 * fetch always adds browser CORS headers such as `sec-fetch-mode: cors`, which
 * some search engines answer with HTTP 429 for a top-level page request.
 * Redirects are not followed; callers validate and follow them hop by hop.
 */
export const plainHttpFetch: FetchLike = async (input, init) => {
	const response = await request(String(input), {
		method: (init?.method ?? "GET") as "GET",
		headers: init?.headers as Record<string, string> | undefined,
		body: typeof init?.body === "string" ? init.body : undefined,
		signal: init?.signal ?? undefined,
	});
	const headers = new Headers();
	for (const [name, value] of Object.entries(response.headers)) {
		if (Array.isArray(value)) for (const item of value) headers.append(name, item);
		else if (value !== undefined) headers.set(name, String(value));
	}
	if (NULL_BODY_STATUSES.has(response.statusCode) || response.statusCode < 200) {
		await response.body.dump().catch(() => {});
		return new Response(null, { status: response.statusCode < 200 ? 502 : response.statusCode, headers });
	}
	const encoding = headers.get("content-encoding")?.trim().toLowerCase();
	const decoder =
		encoding === "gzip" || encoding === "x-gzip"
			? createGunzip()
			: encoding === "br"
				? createBrotliDecompress()
				: encoding === "deflate"
					? createInflate()
					: undefined;
	// pipeline forwards aborts and decode errors to the stream the caller reads.
	const body: Readable = decoder ? pipeline(response.body, decoder, () => {}) : response.body;
	if (decoder) headers.delete("content-encoding");
	return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status: response.statusCode, headers });
};

/** Browser-like headers; several engines return empty or challenge pages to bare clients. */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
};

export interface HttpBytesResponse {
	status: number;
	headers: Headers;
	bytes: Uint8Array;
	/** The body was longer than `maxBytes`; the rest was not downloaded. */
	truncated: boolean;
}

export interface HttpRequestOptions {
	signal?: AbortSignal;
	timeoutMs: number;
	maxBytes: number;
	/** Human-readable target used in diagnostics, e.g. "DuckDuckGo" or a hostname. */
	label: string;
}

/** Surface the low-level network reason (ECONNREFUSED, ENOTFOUND, ...) that `fetch` wraps in `cause`. */
function networkErrorDetail(error: unknown): string {
	const seen = new Set<unknown>();
	let current: unknown = error;
	let innermostMessage: string | undefined;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && code) return `（${code}）`;
		if (current !== error && current instanceof Error && current.message) innermostMessage = current.message;
		current = (current as { cause?: unknown }).cause;
	}
	return innermostMessage ? `（${innermostMessage.slice(0, 120)}）` : "";
}

async function readLimited(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!response.body) return { bytes: new Uint8Array(await response.arrayBuffer()), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const room = maxBytes - total;
		if (value.byteLength >= room) {
			chunks.push(value.subarray(0, room));
			total += room;
			truncated = value.byteLength > room;
			// Stop downloading instead of buffering an unbounded body.
			await reader.cancel().catch(() => {});
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

/**
 * One HTTP request with a per-request timeout, caller cancellation and a body
 * size cap. Redirects are never followed here; callers decide what to do.
 */
export async function requestBytes(
	fetchImpl: FetchLike,
	url: string,
	init: RequestInit,
	options: HttpRequestOptions,
): Promise<HttpBytesResponse> {
	const aborted = abortError(options.signal);
	if (aborted) throw aborted;
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	// The same signal covers headers and body, so cancellation and timeout are
	// classified identically for both phases.
	const classify = (error: unknown, fallback: WebSearchError): WebSearchError => {
		if (options.signal?.aborted) return new WebSearchError("aborted", "联网操作已取消。", { cause: error });
		if (timeoutSignal.aborted || (error as { name?: string })?.name === "TimeoutError") {
			return new WebSearchError("timeout", `${options.label} 请求超时（${options.timeoutMs / 1000} 秒）。`, {
				cause: error,
			});
		}
		return fallback;
	};
	let response: Response;
	try {
		response = await fetchImpl(url, { ...init, redirect: "manual", signal: requestSignal });
	} catch (error) {
		throw classify(
			error,
			new WebSearchError("unavailable", `${options.label} 无法连接${networkErrorDetail(error)}。`, { cause: error }),
		);
	}
	try {
		const body = await readLimited(response, options.maxBytes);
		return { status: response.status, headers: response.headers, ...body };
	} catch (error) {
		throw classify(
			error,
			new WebSearchError("unavailable", `${options.label} 响应在读取过程中中断${networkErrorDetail(error)}。`, {
				cause: error,
			}),
		);
	}
}

/** Decode a body using the charset from Content-Type or an early <meta charset>, defaulting to UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
	let charset = /charset\s*=\s*["']?([\w-]+)/iu.exec(contentType ?? "")?.[1];
	if (!charset) {
		const head = Buffer.from(bytes.subarray(0, 4_096)).toString("latin1");
		charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1];
	}
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}
