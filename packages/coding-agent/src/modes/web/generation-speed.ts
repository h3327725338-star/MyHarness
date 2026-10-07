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

/** Client end-to-end speed: settled reported output / Provider API duration. */
export class GenerationSpeedMeter {
	private value: GenerationSpeed | null = null;

	get current(): GenerationSpeed | null {
		return this.value;
	}

	start(): boolean {
		// Keep a completed observation between requests, never relabel it as live.
		if (this.value?.state === "final") return false;
		const changed = this.value?.state !== "detecting";
		this.value = { state: "detecting", tps: null, live: true };
		return changed;
	}

	update(_message: AgentMessage, _eventType: string | undefined, _delta?: string): boolean {
		// Chunk arrival spans cannot supply a reliable request duration.
		return false;
	}

	end(message: AgentMessage): GenerationSpeed | null {
		if (message.role !== "assistant") return this.value;
		const ms = message.requestDurationMs ?? 0;
		const output = message.usage.output;
		const reported = message.usage.reported?.output ?? output > 0;
		this.value =
			ms > 0 &&
			Number.isFinite(ms) &&
			reported &&
			Number.isSafeInteger(output) &&
			output >= 0 &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted"
				? { state: "final", tps: (output * 1000) / ms, live: false, tokens: output, ms }
				: { state: "unavailable", tps: null, live: false };
		return this.value;
	}

	settle(): boolean {
		if (!this.value?.live) return false;
		this.value = { state: "unavailable", tps: null, live: false };
		return true;
	}
}
