/**
 * Output speed of the model (output tokens per second) for the Web UI.
 *
 * Only real data is used: token counts the provider reports in the message's `usage`, and the time the streamed output
 * actually arrived. The clock starts at the first streamed output (text, thinking or a tool call), so waiting for the
 * first token, the input phase and tool execution are never counted.
 *
 * - While streaming, a live value exists only when the provider reports the output count progressively: it is the
 *   growth between two such reports divided by the time between them. Providers that report usage only at the end
 *   give no live value (`tps: null`) instead of an estimate.
 * - When the message ends, the final value is the reported output tokens over the time from the first streamed output
 *   to the end. When reasoning happens hidden before the first visible output (usage.reasoning without streamed
 *   thinking), only the visible tokens are counted, because the hidden ones were produced before the clock started.
 *   A reply that arrived at once (not streamed) has no reliable duration and gives `null`.
 */

import type { AgentMessage } from "@myharness/agent-core";

export interface GenerationSpeed {
	/** Output tokens per second, or null when it cannot be computed reliably. */
	tps: number | null;
	/** True while the model is producing this message. */
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

	/** The value to show: the live value of the message being generated, or the final value of the last one. */
	get current(): GenerationSpeed | null {
		return this.value;
	}

	/** A new assistant message starts; the previous final value stays until its output begins. */
	start(): void {
		this.firstOutputAt = undefined;
		this.sawThinking = false;
		this.firstObservation = undefined;
		this.lastObservation = undefined;
	}

	/** Returns true when the shown value changed. */
	update(message: AgentMessage, eventType: string | undefined): boolean {
		const at = this.now();
		if (eventType?.startsWith("thinking")) this.sawThinking = true;
		let changed = false;
		if (this.firstOutputAt === undefined && eventType && OUTPUT_EVENTS.has(eventType)) {
			this.firstOutputAt = at;
			this.value = { tps: null, live: true };
			changed = true;
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
				this.value = { tps: (grown * 1000) / span, live: true };
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
			this.value = { tps: null, live: false };
			this.start();
			return this.value;
		}
		const span = at - this.firstOutputAt;
		const output = outputTokens(message);
		const hiddenReasoning = !this.sawThinking ? Math.max(0, message.usage?.reasoning ?? 0) : 0;
		const tokens = output - hiddenReasoning;
		this.value =
			tokens > 0 && span >= MIN_SPAN_MS
				? { tps: (tokens * 1000) / span, live: false, tokens, ms: Math.round(span) }
				: { tps: null, live: false };
		this.start();
		return this.value;
	}
}
