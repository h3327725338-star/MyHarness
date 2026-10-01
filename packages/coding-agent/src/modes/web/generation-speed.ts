/**
 * Output speed of the model (output tokens per second) for the Web UI.
 *
 * Only real data is used: token counts the provider reports in the message's `usage`, and the time the streamed output
 * actually arrived. The clock starts at the first streamed output (text, thinking or a tool call), so waiting for the
 * first token, the input phase and tool execution are never counted.
 *
 * Every model request goes through the same states (`RequestMeterState`):
 * - `detecting`: the request has started and no reliable number exists yet. The value of the previous request is gone;
 *   it is never shown as if it belonged to this one.
 * - `live`: the provider reports the output count progressively, so the speed is the growth between two reports
 *   divided by the time between them. Providers that report usage only at the end stay `detecting` instead of getting
 *   an estimate.
 * - `final`: the request ended with a reliable number: the reported output tokens over the time from the first
 *   streamed output to the end. When reasoning happens hidden before the first visible output (usage.reasoning
 *   without streamed thinking), only the visible tokens are counted, because the hidden ones were produced before the
 *   clock started.
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
}

const OUTPUT_EVENTS = new Set([
	"text_start",
	"text_delta",
	"thinking_start",
	"thinking_delta",
	"toolcall_start",
	"toolcall_delta",
]);
/** Shorter spans are dominated by delivery jitter. */
const MIN_SPAN_MS = 250;

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
	private sawThinking = false;
	private firstObservation: Observation | undefined;
	private lastObservation: Observation | undefined;
	private value: GenerationSpeed | null = null;
	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	/** The value to show: this request's number once it exists, `detecting` until then, the last request's final one between requests. */
	get current(): GenerationSpeed | null {
		return this.value;
	}

	/** A model request starts: whatever was shown belonged to the previous request, so the state goes back to `detecting`. Returns true when the shown value changed. */
	start(): boolean {
		this.firstOutputAt = undefined;
		this.sawThinking = false;
		this.firstObservation = undefined;
		this.lastObservation = undefined;
		const changed = this.value?.state !== "detecting";
		this.value = DETECTING;
		return changed;
	}

	/** Returns true when the shown value changed. */
	update(message: AgentMessage, eventType: string | undefined): boolean {
		const at = this.now();
		if (eventType?.startsWith("thinking")) this.sawThinking = true;
		let changed = false;
		if (this.firstOutputAt === undefined && eventType && OUTPUT_EVENTS.has(eventType)) {
			this.firstOutputAt = at;
			if (this.value?.state !== "detecting") {
				this.value = DETECTING;
				changed = true;
			}
		}
		if (this.firstOutputAt === undefined) return changed;
		const output = outputTokens(message);
		if (output > 0 && output !== this.lastObservation?.output) {
			const observation = { at, output };
			if (!this.firstObservation) this.firstObservation = observation;
			this.lastObservation = observation;
			const span = observation.at - this.firstObservation.at;
			const grown = observation.output - this.firstObservation.output;
			if (span >= MIN_SPAN_MS && grown > 0) {
				this.value = { state: "live", tps: (grown * 1000) / span, live: true };
				changed = true;
			}
		}
		return changed;
	}

	/** The message is complete; returns the final value (also kept as `current`). */
	end(message: AgentMessage): GenerationSpeed | null {
		const at = this.now();
		if (message.role !== "assistant") return this.value;
		if (this.firstOutputAt === undefined) {
			// Nothing was streamed: there is no reliable duration.
			this.value = UNAVAILABLE;
			this.reset();
			return this.value;
		}
		const span = at - this.firstOutputAt;
		const output = outputTokens(message);
		const hiddenReasoning = !this.sawThinking ? Math.max(0, message.usage?.reasoning ?? 0) : 0;
		const tokens = output - hiddenReasoning;
		this.value =
			tokens > 0 && span >= MIN_SPAN_MS
				? { state: "final", tps: (tokens * 1000) / span, live: false, tokens, ms: Math.round(span) }
				: UNAVAILABLE;
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
		this.sawThinking = false;
		this.firstObservation = undefined;
		this.lastObservation = undefined;
	}
}
