/**
 * Direct Bash commands of one AgentSession (the user's `!` / `!!` commands and
 * extension-driven executions): running one command at a time and recording
 * the result in the session history.
 */

import type { Agent } from "@myharness/agent-core";
import type { BashExecutionMessage } from "../../agent/runtime/messages.ts";
import type { SettingsManager } from "../../config/settings/index.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { discardTemporaryToolOutput, persistToolText } from "../tool-result-persistence.ts";
import { type BashOperations, createLocalBashOperations } from "./bash.ts";
import { type BashResult, executeBashWithOperations } from "./executor.ts";

export interface SessionBashHost {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	isDisposed(): boolean;
	/** Whether an agent run is active; results are then queued to keep tool_use/tool_result ordering intact. */
	isStreaming(): boolean;
	/** Register the running command with the session; returns a release function. */
	beginOperation(controller: AbortController): () => void;
	/** Returns a check that tells whether the session runtime that started the command is still the current one. */
	captureRuntimeOwnership(): () => boolean;
}

export interface SessionBashOptions {
	excludeFromContext?: boolean;
	operations?: BashOperations;
	timeout?: number;
}

interface ActiveBashExecution {
	controller: AbortController;
	completion?: Promise<BashResult>;
}

export class SessionBashRunner {
	private readonly _host: SessionBashHost;
	private _active: ActiveBashExecution | undefined;
	private _executionCount = 0;
	private _pendingMessages: BashExecutionMessage[] = [];

	constructor(host: SessionBashHost) {
		this._host = host;
	}

	/** Monotonic count of bash executions recorded this session. */
	get executionCount(): number {
		return this._executionCount;
	}

	/** Whether a bash command is currently running */
	get isRunning(): boolean {
		return this._active !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingMessages(): boolean {
		return this._pendingMessages.length > 0;
	}

	/** Completion of the running command, if any (used to wait during disposal). */
	get activeCompletion(): Promise<BashResult> | undefined {
		return this._active?.completion;
	}

	/** Cancel running bash command. */
	abort(): void {
		this._active?.controller.abort();
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async execute(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: SessionBashOptions,
	): Promise<BashResult> {
		const { sessionManager, settingsManager } = this._host;
		if (this._host.isDisposed()) throw new Error("Cannot execute Bash on a disposed session.");
		if (this._active) {
			throw new Error("A direct Bash command is already running for this session.");
		}

		const abortController = new AbortController();
		const ownsRuntime = this._host.captureRuntimeOwnership();
		const endOperation = this._host.beginOperation(abortController);
		const execution: ActiveBashExecution = { controller: abortController };
		this._active = execution;

		try {
			// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
			const prefix = settingsManager.getShellCommandPrefix();
			const shellPath = settingsManager.getShellPath();
			const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
			const completion = executeBashWithOperations(
				resolvedCommand,
				sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: abortController.signal,
					timeout: options?.timeout,
				},
			);
			execution.completion = completion;
			const result = await completion;
			if (!ownsRuntime()) {
				await discardTemporaryToolOutput(result.fullOutputPath);
				return result;
			}
			let recordedResult = result;
			if (result.fullOutputPath) {
				try {
					const fullOutputPath = await persistToolText(
						sessionManager,
						"bash",
						`direct-${this._executionCount + 1}-${Date.now()}`,
						result.output,
						result.fullOutputPath,
					);
					recordedResult = { ...result, fullOutputPath };
				} catch {
					// Command success must not be turned into a failure solely because
					// durable full-output persistence is unavailable. Do not retain the
					// intermediate path in Session JSONL: it is not a durable reference.
					await discardTemporaryToolOutput(result.fullOutputPath);
					recordedResult = { ...result, fullOutputPath: undefined };
				}
			}
			if (ownsRuntime()) this.recordResult(command, recordedResult, options);
			return recordedResult;
		} finally {
			if (this._active === execution) this._active = undefined;
			endOperation();
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by execute() and by extensions that handle bash execution themselves.
	 */
	recordResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._executionCount++;
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			timedOut: result.timedOut,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this._host.isStreaming()) {
			// Queue for later - will be flushed on agent_end
			this._pendingMessages.push(bashMessage);
		} else {
			// Commit the durable session entry before mutating the in-memory
			// transcript. A persistence failure must not leave the two views split.
			this._host.sessionManager.appendMessage(bashMessage);
			this._host.agent.state.messages.push(bashMessage);
		}
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	flushPendingMessages(): void {
		if (this._pendingMessages.length === 0) return;

		while (this._pendingMessages.length > 0) {
			const bashMessage = this._pendingMessages[0];
			// Remove each message only after its durable append succeeds. If a
			// later append fails, the remaining queue can be retried without
			// duplicating entries that already committed.
			this._host.sessionManager.appendMessage(bashMessage);
			this._host.agent.state.messages.push(bashMessage);
			this._pendingMessages.shift();
		}
	}
}
