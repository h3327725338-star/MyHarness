import type { AgentMessage } from "@myharness/agent-core";

export type RequestMeterState = "detecting" | "live" | "final" | "unavailable";

export interface GenerationSpeed {
	state: RequestMeterState;
	tps: number | null;
	live: boolean;
	tokens?: number;
	ms?: number;
	estimated?: boolean;
}

/** DeepSeek-style decode speed: settled reported output / first-output-to-completion time. */
export class GenerationSpeedMeter {
	private firstOutputAt: number | undefined;
	private value: GenerationSpeed | null = null;

	private readonly now: () => number;
	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	get current(): GenerationSpeed | null {
		return this.value;
	}

	start(): boolean {
		this.firstOutputAt = undefined;
		// Keep a completed observation between requests, never relabel it as live.
		if (this.value?.state === "final") return false;
		const changed = this.value?.state !== "detecting";
		this.value = { state: "detecting", tps: null, live: true };
		return changed;
	}

	update(_message: AgentMessage, eventType: string | undefined, delta?: string): boolean {
		if (
			this.firstOutputAt === undefined &&
			(eventType === "text_delta" || eventType === "thinking_delta" || eventType === "toolcall_delta") &&
			delta
		)
			this.firstOutputAt = this.now();
		// Streaming chunks establish timing, not an estimated or sliding-window TPS.
		return false;
	}

	end(message: AgentMessage): GenerationSpeed | null {
		if (message.role !== "assistant") return this.value;
		const ms = this.firstOutputAt === undefined ? 0 : this.now() - this.firstOutputAt;
		const output = message.usage.output;
		const reported = message.usage.reported?.output ?? output > 0;
		this.value =
			ms > 0 && Number.isFinite(ms) && reported && Number.isSafeInteger(output) && output >= 0
				? { state: "final", tps: (output * 1000) / ms, live: false, tokens: output, ms }
				: { state: "unavailable", tps: null, live: false };
		this.firstOutputAt = undefined;
		return this.value;
	}

	settle(): boolean {
		this.firstOutputAt = undefined;
		if (!this.value?.live) return false;
		this.value = { state: "unavailable", tps: null, live: false };
		return true;
	}
}
