/**
 * Prompt-cache hit rate of one model request for the Web UI, with the same states as the output speed
 * (`RequestMeterState`, see generation-speed.ts): `detecting` from the moment the request starts, `live` as soon as the
 * provider has reported this request's input usage, `final` when the request ends.
 *
 * Only what the provider reports is used. Usage is already normalised per protocol (`input` = tokens that were not
 * served from the cache, `cacheRead` = tokens read from the cache, `cacheWrite` = tokens written to it), so the rate is
 * cacheRead / (input + cacheRead + cacheWrite) for every protocol. A provider that never reports any cache use cannot be
 * told apart from one that reports zero, so a request without cache tokens only counts as a real 0% once the session
 * has seen cache use before; otherwise it is `unavailable`, never an invented 0%.
 */

import type { AgentMessage } from "@myharness/agent-core";
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
}

const DETECTING: RequestCacheHit = { state: "detecting", hitRate: null };
const UNAVAILABLE: RequestCacheHit = { state: "unavailable", hitRate: null };

interface Usage {
	input: number;
	read: number;
	write: number;
}

function usageOf(message: AgentMessage): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	const usage = message.usage;
	if (!usage) return undefined;
	const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	return { input: number(usage.input), read: number(usage.cacheRead), write: number(usage.cacheWrite) };
}

export class RequestCacheMeter {
	private value: RequestCacheHit | null = null;
	/** Whether the provider has reported any cache use in this session (before this request or during it). */
	private reported = false;

	get current(): RequestCacheHit | null {
		return this.value;
	}

	/**
	 * A model request starts. `reportedBefore`: the session's earlier requests already contained cache tokens. Returns
	 * true when the shown value changed.
	 */
	start(reportedBefore: boolean): boolean {
		this.reported = reportedBefore;
		const changed = this.value?.state !== "detecting";
		this.value = DETECTING;
		return changed;
	}

	/** Returns true when the shown value changed. */
	update(message: AgentMessage): boolean {
		const usage = usageOf(message);
		if (!usage) return false;
		const prompt = usage.input + usage.read + usage.write;
		if (prompt <= 0) return false;
		if (usage.read + usage.write > 0) this.reported = true;
		// Without any reported cache use the number would be a guess: wait for the end of the request to say so.
		if (!this.reported) return false;
		const next: RequestCacheHit = {
			state: "live",
			hitRate: usage.read / prompt,
			read: usage.read,
			write: usage.write,
			input: prompt,
		};
		if (this.value?.state === "live" && this.value.hitRate === next.hitRate && this.value.input === next.input)
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
		if (usage.read + usage.write > 0) this.reported = true;
		this.value = this.reported
			? { state: "final", hitRate: usage.read / prompt, read: usage.read, write: usage.write, input: prompt }
			: UNAVAILABLE;
		return this.value;
	}

	/** The run ended while the request was still being measured: a live value stays as the last reliable one. Returns true when the shown value changed. */
	settle(): boolean {
		if (!this.value || (this.value.state !== "detecting" && this.value.state !== "live")) return false;
		this.value = this.value.state === "live" ? { ...this.value, state: "final" } : UNAVAILABLE;
		return true;
	}
}
