import type { AgentEvent } from "@myharness/agent-core";
import type { ProviderResponse, ProviderResponseMetadata } from "@myharness/ai";
import type { AssistantMessage, Model } from "@myharness/ai/compat";
import {
	classifyToolStatus,
	getRuntimeTraceOptionsFromEnvironment,
	RuntimeTrace,
	type RuntimeTraceScope,
	type RuntimeTraceStatus,
} from "./runtime-trace.ts";

/**
 * Runtime trace ownership for one AgentSession.
 *
 * Trace files are operational diagnostics, not session history. Keeping the
 * lifecycle here lets AgentSession coordinate a run without owning the trace
 * writer's queueing, scope, and unfinished-tool bookkeeping.
 */
export class AgentSessionTraceCoordinator {
	private readonly runtimeTrace: RuntimeTrace;
	private readonly cwd: string;
	private readonly traceAgentId: string;
	private readonly initialRunId: string | undefined;
	private initialRunConsumed = false;
	private activeRun: RuntimeTraceScope | undefined;
	private lastRun: RuntimeTraceScope | undefined;
	private terminalStatus: RuntimeTraceStatus = "completed";
	private turnIndex = 0;
	private toolStarts = new Map<string, { startedAt: number; scope: RuntimeTraceScope; toolName: string }>();
	private modelRequests: Array<{ requestId: string; startedAt: number; scope: RuntimeTraceScope }> = [];
	private pendingWrites: Promise<void> = Promise.resolve();
	private writeError: Error | undefined;

	constructor(options: { cwd: string; traceDir: string; sessionId: string }) {
		this.cwd = options.cwd;
		const traceOptions = getRuntimeTraceOptionsFromEnvironment(options.cwd, {
			traceDir: options.traceDir,
			sessionId: options.sessionId,
		});
		this.runtimeTrace = new RuntimeTrace({ ...traceOptions, cwd: options.cwd });
		this.traceAgentId = this.runtimeTrace.createScope().agentId;
		this.initialRunId = traceOptions.runId;
	}

	get writer(): RuntimeTrace {
		return this.runtimeTrace;
	}

	get activeScope(): RuntimeTraceScope | undefined {
		return this.activeRun;
	}

	get lastScope(): RuntimeTraceScope | undefined {
		return this.lastRun;
	}

	record(scope: RuntimeTraceScope, type: Parameters<RuntimeTrace["record"]>[1], data?: Record<string, unknown>): void {
		this.queue(() => this.runtimeTrace.record(scope, type, data));
	}

	recordAgentEvent(event: AgentEvent, willRetry: boolean | undefined, model: Model<any> | undefined): void {
		if (event.type === "agent_start") {
			if (!this.activeRun) {
				this.activeRun = this.createRunScope();
				this.terminalStatus = "completed";
				this.turnIndex = 0;
				this.pendingWrites = Promise.resolve();
				this.writeError = undefined;
				this.record(this.activeRun, "run-started", { cwd: this.cwd });
			}
			this.record(this.activeRun, "agent-started", {
				attempt: this.turnIndex === 0 ? 1 : this.turnIndex + 1,
			});
			return;
		}

		const scope = this.activeRun;
		if (!scope) return;
		if (event.type === "turn_start") {
			this.turnIndex += 1;
			const requestId = this.runtimeTrace.createId("model-request");
			this.modelRequests.push({ requestId, startedAt: Date.now(), scope });
			this.record(scope, "turn-started", { turnIndex: this.turnIndex });
			this.record(scope, "model-request", {
				requestId,
				provider: model?.provider,
				model: model?.id,
			});
			return;
		}
		if (event.type === "turn_end") {
			const message = event.message as AssistantMessage;
			const status: RuntimeTraceStatus =
				message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "failed" : "completed";
			const request = this.modelRequests.shift();
			this.record(scope, "turn-finished", {
				turnIndex: this.turnIndex,
				status,
				toolCount: event.toolResults.length,
			});
			this.record(scope, "model-response", {
				requestId: request?.requestId ?? this.runtimeTrace.createId("model-request"),
				provider: message.provider,
				model: message.model,
				status,
				durationMs: request ? Date.now() - request.startedAt : undefined,
				error: message.errorMessage,
				usage: message.usage,
			});
			return;
		}
		if (event.type === "tool_execution_start") {
			this.toolStarts.set(event.toolCallId, { startedAt: Date.now(), scope, toolName: event.toolName });
			this.queue(() => this.runtimeTrace.recordToolStarted(scope, event.toolCallId, event.toolName, event.args));
			return;
		}
		if (event.type === "tool_execution_end") {
			const started = this.toolStarts.get(event.toolCallId);
			this.toolStarts.delete(event.toolCallId);
			const toolScope = started?.scope ?? scope;
			const status = classifyToolStatus(event.result, event.isError);
			this.queue(() =>
				this.runtimeTrace.recordToolFinished(
					toolScope,
					event.toolCallId,
					event.toolName,
					status,
					started ? Date.now() - started.startedAt : 0,
					event.result,
					event.isError,
				),
			);
			return;
		}
		if (event.type === "agent_end") {
			const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant") as
				| AssistantMessage
				| undefined;
			const status: RuntimeTraceStatus =
				lastAssistant?.stopReason === "aborted"
					? "cancelled"
					: lastAssistant?.stopReason === "error"
						? willRetry
							? "retrying"
							: "failed"
						: "completed";
			this.terminalStatus = status;
			this.record(scope, "agent-finished", {
				status,
				willRetry: Boolean(willRetry),
				messageCount: event.messages.length,
			});
			if (this.modelRequests.length > 0) {
				const pending = this.modelRequests.splice(0);
				for (const request of pending) {
					this.record(request.scope, "model-response", {
						requestId: request.requestId,
						status: status === "cancelled" ? "cancelled" : "failed",
						durationMs: Date.now() - request.startedAt,
						error: lastAssistant?.errorMessage,
					});
				}
			}
		}
	}

	async finish(): Promise<void> {
		const scope = this.activeRun;
		if (!scope) return;
		if (this.toolStarts.size > 0) {
			const status = this.terminalStatus === "cancelled" ? "cancelled" : "failed";
			for (const [toolCallId, tool] of this.toolStarts) {
				this.queue(() =>
					this.runtimeTrace.recordToolFinished(
						scope,
						toolCallId,
						tool.toolName,
						status,
						Date.now() - tool.startedAt,
						{ interrupted: true },
						true,
					),
				);
			}
		}
		this.record(scope, "run-finished", { status: this.terminalStatus });
		try {
			await this.pendingWrites;
			await this.runtimeTrace.flush(scope.runId);
		} catch (error) {
			this.writeError ??= error instanceof Error ? error : new Error(String(error));
		}
		this.lastRun = scope;
		this.activeRun = undefined;
		this.toolStarts.clear();
		this.modelRequests = [];
		this.pendingWrites = Promise.resolve();
		const writeError = this.writeError;
		this.writeError = undefined;
		if (writeError) {
			throw new Error(`运行轨迹写入失败，任务不能被视为成功：${writeError.message}`);
		}
	}

	recordProviderResponse(response: ProviderResponse, model: Model<any>): ProviderResponseMetadata {
		const metadata = response.metadata
			? { ...response.metadata, status: response.status }
			: { status: response.status };
		if (this.activeRun) {
			this.record(this.activeRun, "provider-response", {
				provider: model.provider,
				model: model.id,
				metadata,
			});
		}
		return metadata;
	}

	private createRunScope(): RuntimeTraceScope {
		const runId = !this.initialRunConsumed ? this.initialRunId : undefined;
		this.initialRunConsumed = true;
		return this.runtimeTrace.createScope({ runId, agentId: this.traceAgentId });
	}

	private queue(write: () => Promise<void>): void {
		let writePromise: Promise<void>;
		try {
			writePromise = write();
		} catch (error) {
			this.writeError ??= error instanceof Error ? error : new Error(String(error));
			return;
		}
		const safeWrite = writePromise.catch((error) => {
			this.writeError ??= error instanceof Error ? error : new Error(String(error));
		});
		this.pendingWrites = this.pendingWrites.then(() => safeWrite);
	}
}
