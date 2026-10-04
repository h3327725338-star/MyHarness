/**
 * Prompt-cache hit rate of one model request for the Web UI, with the same states as the output speed
 * (`RequestMeterState`, see generation-speed.ts): `detecting` from the moment the request starts, `live` as soon as the
 * provider has reported this request's input usage, `final` when the request ends.
 *
 * Only what the provider reports is used. Usage is already normalised per protocol (`input` = tokens that were not
 * served from the cache, `cacheRead` = tokens read from the cache, `cacheWrite` = tokens written to it), so the rate is
 * cacheRead / (input + cacheRead + cacheWrite) for every protocol. A provider that never reports any cache use cannot be
 * told apart from one that reports zero in older sessions. New responses preserve explicit cache counters through
 * `cacheReported`, so a measured zero is valid even on the first request; absent counters remain unavailable.
 *
 * Providers that report their usage only in the last chunk of the reply (the OpenAI-compatible ones) have nothing to
 * show while the reply streams. The Web host now waits for measured usage rather than predicting cache hits.
 * Prediction helpers remain for compatibility, but are not used for the live Web UI.
 */

import type { AgentMessage } from "@myharness/agent-core";
import { estimateContextTokens } from "../../context/compact/compaction.ts";
import { measureCache } from "../../observability/usage-measurements.ts";
import type { RequestMeterState } from "./generation-speed.ts";

export interface RequestCacheHit {
	state: RequestMeterState;
	/** Share of this request's input tokens served from the provider's prompt cache (0..1), or null when there is no reliable number. */
	hitRate: number | null;
	/** The request's usage the rate is based on. */
	read?: number;
	write?: number;
	/** Input tokens of the request in total (not cached + cache reads + cache writes). */
	input?: number;
	/** The number is a prediction from the previous request, not what the provider reported. */
	estimated?: boolean;
}

const DETECTING: RequestCacheHit = { state: "detecting", hitRate: null };
const UNAVAILABLE: RequestCacheHit = { state: "unavailable", hitRate: null };

interface Usage {
	input: number;
	read: number;
	write: number;
	reported: boolean;
}

function usageOf(message: AgentMessage, prediction = false): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	const usage = message.usage;
	if (!usage) return undefined;
	const measured = measureCache(usage);
	if (!prediction && measured.hitRate.value === null) return undefined;
	const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	return {
		input: prediction
			? number(usage.input)
			: measured.prompt.value! - number(usage.cacheRead) - number(usage.cacheWrite),
		read: number(usage.cacheRead),
		write: number(usage.cacheWrite),
		reported: true,
	};
}

/** Prompts shorter than this are not cached by the providers that have a minimum (1024 tokens). */
const MIN_CACHEABLE_TOKENS = 1024;
/** Provider caches live for minutes (5 for Anthropic by default); after a longer pause nothing is predicted. */
const MAX_CACHE_AGE_MS = 10 * 60 * 1000;

/**
 * What the next request is expected to read from the provider's cache: the previous request's whole prompt (the new
 * request starts with it), out of the estimated size of the new prompt. Undefined when no reliable guess exists: no
 * earlier request with a reported prompt, a prompt too short to be cached, or a pause long enough for the cache to expire.
 */
export function predictCacheHit(
	messages: AgentMessage[],
	now = Date.now(),
): { read: number; input: number } | undefined {
	let last: AgentMessage | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		const usage = usageOf(message, true);
		if (usage && usage.input + usage.read + usage.write > 0) {
			last = message;
			break;
		}
	}
	const usage = last ? usageOf(last, true) : undefined;
	if (!last || !usage) return undefined;
	const previousPrompt = usage.input + usage.read + usage.write;
	if (previousPrompt < MIN_CACHEABLE_TOKENS) return undefined;
	if (typeof last.timestamp === "number" && now - last.timestamp > MAX_CACHE_AGE_MS) return undefined;
	const total = estimateContextTokens(messages).tokens;
	if (total <= 0) return undefined;
	return { read: Math.min(previousPrompt, total), input: Math.max(total, previousPrompt) };
}

export class RequestCacheMeter {
	private value: RequestCacheHit | null = null;
	/** Whether the provider has reported any cache use in this session (before this request or during it). */
	private reported = false;

	get current(): RequestCacheHit | null {
		return this.value;
	}

	/**
	 * A model request starts. `reportedBefore`: the session's earlier requests already contained cache tokens.
	 * `predicted`: what the request is expected to read from the cache (see predictCacheHit), shown until the provider
	 * reports the real usage; only used for a provider that has reported cache use before. Returns true when the shown
	 * value changed.
	 */
	start(reportedBefore: boolean, predicted?: { read: number; input: number }): boolean {
		this.reported = reportedBefore;
		const next: RequestCacheHit =
			reportedBefore && predicted && predicted.input > 0
				? {
						state: "live",
						hitRate: Math.min(1, predicted.read / predicted.input),
						read: predicted.read,
						input: predicted.input,
						estimated: true,
					}
				: this.value?.hitRate != null
					? { ...this.value, state: "final" }
					: DETECTING;
		const changed = JSON.stringify(this.value) !== JSON.stringify(next);
		this.value = next;
		return changed;
	}

	/** Returns true when the shown value changed. */
	update(message: AgentMessage): boolean {
		const usage = usageOf(message);
		if (!usage) return false;
		const prompt = usage.input + usage.read + usage.write;
		if (prompt <= 0) return false;
		if (usage.reported || usage.read + usage.write > 0) this.reported = true;
		// Without any reported cache use the number would be a guess: wait for the end of the request to say so.
		if (!this.reported) return false;
		const next: RequestCacheHit = {
			state: "live",
			hitRate: usage.read / prompt,
			read: usage.read,
			write: usage.write,
			input: prompt,
		};
		if (
			this.value?.state === "live" &&
			!this.value.estimated &&
			this.value.hitRate === next.hitRate &&
			this.value.input === next.input
		)
			return false;
		this.value = next;
		return true;
	}

	/** The message is complete; returns the request's final value (also kept as `current`). */
	end(message: AgentMessage): RequestCacheHit | null {
		if (message.role !== "assistant") return this.value;
		const usage = usageOf(message);
		const prompt = usage ? usage.input + usage.read + usage.write : 0;
		if (!usage || prompt <= 0) {
			this.value = UNAVAILABLE;
			return this.value;
		}
		if (usage.reported || usage.read + usage.write > 0) this.reported = true;
		this.value = this.reported
			? { state: "final", hitRate: usage.read / prompt, read: usage.read, write: usage.write, input: prompt }
			: this.value?.hitRate != null
				? { ...this.value, state: "final" }
				: UNAVAILABLE;
		return this.value;
	}

	/** The run ended while the request was still being measured: a live value stays as the last reliable one. Returns true when the shown value changed. */
	settle(): boolean {
		if (!this.value || (this.value.state !== "detecting" && this.value.state !== "live")) return false;
		// A prediction is not a measurement: a request that ended without the provider's numbers has none.
		this.value =
			this.value.state === "live" && !this.value.estimated ? { ...this.value, state: "final" } : UNAVAILABLE;
		return true;
	}
}
