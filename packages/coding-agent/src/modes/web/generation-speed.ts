/**
 * Output speed of the model (output tokens per second) for the Web UI.
 *
 * Only real data is used: token counts the provider reports in the message's `usage`, and the time the streamed output
 * actually arrived. The clock starts at the first streamed output (text, thinking or a tool call), so waiting for the
 * first token, the input phase and tool execution are never counted.
 *
 * Every model request goes through the same states (`RequestMeterState`):
 * - `detecting`: no reliable measurement has been obtained yet. A previous measurement remains final until
 *   a new request has a replacement; it is never marked live for the new request.
 * - `live`: the speed over the last second or so of streaming, updated with every streamed piece. The token count
 *   is the one the provider reports progressively; a provider that reports usage only at the end gets a count
 *   estimated from the streamed text (about 4 characters per token, 0.7 token per CJK character), flagged
 *   `estimated`, so the number still moves while the reply is written. The final value replaces it with the
 *   reported one.
 * - `final`: reported output tokens (reasoning included once) divided by the time from the first non-empty
 *   streamed output to the end, matching the session aggregate and DeepSeek's decode metric.
 * - `unavailable`: the request ended without a reliable number (a reply that arrived at once, no reported output
 *   tokens, a span too short to measure, or a request that was stopped before any number existed).
 */

import type { AgentMessage } from "@myharness/agent-core";

/** The states every per-request number (speed, cache hit) goes through. */
export type RequestMeterState = "detecting" | "live" | "final" | "unavailable";

export interface GenerationSpeed {
	state: RequestMeterState;
	/** Output tokens per second, or null when there is no reliable number (yet). */
	tps: number | null;
	/** True while the model is producing this message (`detecting` and `live`). */
	live: boolean;
	/** Tokens and milliseconds the final value is based on. */
	tokens?: number;
	ms?: number;
	/** The token count behind the number was estimated from the streamed text, not reported by the provider. */
	estimated?: boolean;
}

const OUTPUT_EVENTS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
/** Shorter spans are dominated by delivery jitter. */
const MIN_SPAN_MS = 250;
/** The live speed is the throughput of roughly this much recent streaming. */
const WINDOW_MS = 1500;

/** Rough token count of a streamed piece of text, only used while the provider has reported nothing. */
export function estimateStreamedTokens(text: string): number {
	let tokens = 0;
	for (let i = 0; i < text.length; i++) tokens += text.charCodeAt(i) < 128 ? 0.25 : 0.7;
	return tokens;
}

interface Observation {
	at: number;
	output: number;
}

function outputTokens(message: AgentMessage): number {
	if (message.role !== "assistant") return 0;
	const output = message.usage?.output;
	return typeof output === "number" && Number.isFinite(output) && output > 0 ? output : 0;
}

const DETECTING: GenerationSpeed = { state: "detecting", tps: null, live: true };
const UNAVAILABLE: GenerationSpeed = { state: "unavailable", tps: null, live: false };

export class GenerationSpeedMeter {
	private firstOutputAt: number | undefined;
	private firstObservation: Observation | undefined;
	private lastObservation: Observation | undefined;
	/** Streamed output so far, estimated from the text, and the recent history of it. */
	private estimated = 0;
	private samples: Observation[] = [];
	private usingReported = false;
	private value: GenerationSpeed | null = null;
	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	/** The value to show: this request's number once it exists, `detecting` until then, the last request's final one between requests. */
	get current(): GenerationSpeed | null {
		return this.value;
	}

	/** Reset timing for a new request; retain the last final value until a replacement is measured. */
	start(): boolean {
		this.reset();
		if (this.value?.tps != null) {
			const changed = this.value.state !== "final" || this.value.live;
			this.value = { ...this.value, state: "final", live: false };
			return changed;
		}
		const changed = this.value?.state !== "detecting";
		this.value = DETECTING;
		return changed;
	}

	/** Returns true when the shown value changed. */
	update(message: AgentMessage, eventType: string | undefined, delta?: string): boolean {
		const at = this.now();
		let changed = false;
		if (this.firstOutputAt === undefined && eventType && OUTPUT_EVENTS.has(eventType) && !!delta) {
			this.firstOutputAt = at;
			this.samples = [{ at, output: 0 }];
			if (this.value?.tps == null && this.value?.state !== "detecting") {
				this.value = DETECTING;
				changed = true;
			}
		}
		if (this.firstOutputAt === undefined) return changed;
		if (delta) this.estimated += estimateStreamedTokens(delta);
		const output = outputTokens(message);
		// Reported counts win as soon as the provider sends any; until then the streamed text stands in.
		const reported = output > 0;
		if (reported && output !== this.lastObservation?.output) {
			const observation = { at, output };
			if (!this.firstObservation) this.firstObservation = observation;
			this.lastObservation = observation;
		}
		if (!reported && !delta) return changed;
		// The two counts have different scales: restart the window when the provider's counts take over.
		if (reported && !this.usingReported) {
			this.usingReported = true;
			this.samples = [];
		}
		this.samples.push({ at, output: reported ? output : this.estimated });
		const horizon = at - WINDOW_MS;
		while (this.samples.length > 2 && this.samples[1]!.at <= horizon) this.samples.shift();
		const first = this.samples[0]!;
		const span = at - first.at;
		const grown = (reported ? output : this.estimated) - first.output;
		if (span >= MIN_SPAN_MS && grown > 0) {
			this.value = {
				state: "live",
				tps: (grown * 1000) / span,
				live: true,
				...(reported ? {} : { estimated: true }),
			};
			changed = true;
		}
		return changed;
	}

	/** The message is complete; returns the final value (also kept as `current`). */
	end(message: AgentMessage): GenerationSpeed | null {
		const at = this.now();
		if (message.role !== "assistant") return this.value;
		if (this.firstOutputAt === undefined) {
			// Nothing was streamed: never attribute the previous request's speed to this one.
			this.value = UNAVAILABLE;
			this.reset();
			return this.value;
		}
		const span = at - this.firstOutputAt;
		const output = outputTokens(message);
		const tokens = output;
		if (tokens > 0 && span >= MIN_SPAN_MS) {
			this.value = { state: "final", tps: (tokens * 1000) / span, live: false, tokens, ms: Math.round(span) };
		} else if (output === 0 && this.estimated > 0 && span >= MIN_SPAN_MS) {
			// The provider reported no output count at all: the estimate is all there is.
			const estimated = Math.round(this.estimated);
			this.value = {
				state: "final",
				tps: (estimated * 1000) / span,
				live: false,
				tokens: estimated,
				ms: Math.round(span),
				estimated: true,
			};
		} else {
			this.value = UNAVAILABLE;
		}
		this.reset();
		return this.value;
	}

	/**
	 * The run ended (finished, failed or stopped) while a request was still being measured: its number never became
	 * final, so a live value is kept as the last reliable one and `detecting` becomes `unavailable`. Returns true when
	 * the shown value changed.
	 */
	settle(): boolean {
		if (!this.value || !this.value.live) return false;
		this.value =
			this.value.state === "live" && this.value.tps !== null
				? { ...this.value, state: "final", live: false }
				: UNAVAILABLE;
		this.reset();
		return true;
	}

	private reset(): void {
		this.firstOutputAt = undefined;
		this.firstObservation = undefined;
		this.lastObservation = undefined;
		this.estimated = 0;
		this.samples = [];
		this.usingReported = false;
	}
}
