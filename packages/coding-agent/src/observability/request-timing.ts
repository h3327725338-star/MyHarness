import type { AgentEvent } from "@myharness/agent-core";
import type { SessionMessageTiming } from "../session/types.ts";

/** Measure actual non-empty output, independently of UI subscriptions and wall-clock changes. */
export class RequestTimingTracker {
	private requestStart: number | undefined;
	private firstOutput: number | undefined;
	private tools = new Map<string, number>();
	private finishedTools = new Map<string, number>();

	private readonly now: () => number;
	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	observe(event: AgentEvent): SessionMessageTiming | undefined {
		const at = this.now();
		if (event.type === "turn_start") {
			this.requestStart = at;
			this.firstOutput = undefined;
		} else if (event.type === "message_start" && event.message.role === "assistant") {
			this.requestStart ??= at;
			this.firstOutput = undefined;
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			const output = event.assistantMessageEvent;
			if (
				this.requestStart !== undefined &&
				this.firstOutput === undefined &&
				(output.type === "text_delta" || output.type === "thinking_delta" || output.type === "toolcall_delta") &&
				output.delta.length > 0
			)
				this.firstOutput = at;
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			if (this.requestStart === undefined) return undefined;
			const timing: SessionMessageTiming = {
				requestMs: Math.max(0, at - this.requestStart),
				...(typeof event.message.requestDurationMs === "number" &&
				Number.isFinite(event.message.requestDurationMs) &&
				event.message.requestDurationMs > 0
					? { providerRequestMs: event.message.requestDurationMs }
					: {}),
				...(this.firstOutput === undefined
					? {}
					: {
							firstOutputMs: Math.max(0, this.firstOutput - this.requestStart),
							generationMs: Math.max(0, at - this.firstOutput),
						}),
			};
			this.requestStart = undefined;
			this.firstOutput = undefined;
			return timing;
		} else if (event.type === "tool_execution_start") {
			this.tools.set(event.toolCallId, at);
		} else if (event.type === "tool_execution_end") {
			const start = this.tools.get(event.toolCallId);
			if (start !== undefined) this.finishedTools.set(event.toolCallId, Math.max(0, at - start));
			this.tools.delete(event.toolCallId);
		} else if (event.type === "message_end" && event.message.role === "toolResult") {
			const toolMs = this.finishedTools.get(event.message.toolCallId);
			this.finishedTools.delete(event.message.toolCallId);
			return toolMs === undefined ? undefined : { toolMs };
		} else if (event.type === "agent_end") {
			this.reset();
		}
		return undefined;
	}

	reset(): void {
		this.requestStart = undefined;
		this.firstOutput = undefined;
		this.tools.clear();
		this.finishedTools.clear();
	}
}
