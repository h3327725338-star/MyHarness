import type { AgentEvent } from "@myharness/agent-core";
import { isBashCommandReadOnly } from "../repository/bash-command-classifier.ts";
import {
	completeGitCheckpoint,
	createGitCheckpoint,
	type GitCheckpoint,
	type GitCheckpointToolName,
	isPathInsideRepository,
	persistGitCheckpoint,
	retainGitCheckpoint,
} from "./checkpoint.ts";

export type GitCheckpointLifecycleEvent =
	| { type: "git_checkpoint_start" }
	| { type: "git_checkpoint_end"; ok: boolean; checkpointId?: string; error?: string };

function getMutationPath(toolName: string, args: unknown): string | undefined {
	if (toolName !== "edit" && toolName !== "write") return undefined;
	if (!args || typeof args !== "object") return undefined;
	const input = args as Record<string, unknown>;
	const filePath = input.path ?? input.file_path;
	return typeof filePath === "string" && filePath.trim() ? filePath : undefined;
}

function getBashCommand(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const command = (args as Record<string, unknown>).command;
	return typeof command === "string" ? command : undefined;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "symbols"]);

function classifyTool(
	toolName: string,
	args: unknown,
): { requiresCheckpoint: boolean; checkpointToolName?: GitCheckpointToolName; mutationPath?: string } {
	const mutationPath = getMutationPath(toolName, args);
	if (toolName === "edit" || toolName === "write") {
		return mutationPath
			? { requiresCheckpoint: true, checkpointToolName: toolName, mutationPath }
			: { requiresCheckpoint: false };
	}
	if (toolName === "bash") {
		const command = getBashCommand(args);
		return {
			requiresCheckpoint: command === undefined || !isBashCommandReadOnly(command),
			checkpointToolName: "bash",
		};
	}
	if (READ_ONLY_TOOLS.has(toolName)) return { requiresCheckpoint: false };
	return { requiresCheckpoint: true, checkpointToolName: "scan" };
}

export interface AgentSessionGitCheckpointHost {
	cwd: string;
	sessionId: string;
	excludedPaths: string[];
	isDelegated: boolean;
	isEnabled: () => boolean;
	onEvent: (event: GitCheckpointLifecycleEvent) => void;
	onActivity: (activity: string) => void;
}

/** Owns the task checkpoint lifecycle while AgentSession coordinates when it runs. */
export class AgentSessionGitCheckpointCoordinator {
	private checkpoint: GitCheckpoint | undefined;
	private preparationPromise: Promise<void> | undefined;

	private readonly host: AgentSessionGitCheckpointHost;

	constructor(host: AgentSessionGitCheckpointHost) {
		this.host = host;
	}

	async prepare(): Promise<void> {
		if (this.checkpoint?.status === "created") return;
		if (this.preparationPromise) {
			await this.preparationPromise;
			return;
		}
		if (this.host.isDelegated || !this.host.isEnabled()) return;
		const preparation = this.create();
		this.preparationPromise = preparation;
		try {
			await preparation;
		} finally {
			if (this.preparationPromise === preparation) this.preparationPromise = undefined;
		}
	}

	async prepareForTool(event: Extract<AgentEvent, { type: "tool_execution_start" }>): Promise<void> {
		const tool = classifyTool(event.toolName, event.args);
		if (!tool.requiresCheckpoint || !tool.checkpointToolName) return;
		await this.prepare();
		const checkpoint = this.checkpoint;
		if (!checkpoint) return;
		if (tool.mutationPath && !isPathInsideRepository(checkpoint, tool.mutationPath)) return;
		if (tool.checkpointToolName === "bash") {
			checkpoint.hadBashExecution = true;
			persistGitCheckpoint(checkpoint);
		}
	}

	completeCurrent(): { ok: boolean; error?: string } {
		if (!this.checkpoint) return { ok: true };
		const result = completeGitCheckpoint(this.checkpoint);
		return result.ok ? { ok: true } : { ok: false, error: result.error ?? "无法标记任务检查点已完成。" };
	}

	retain(checkpoint = this.checkpoint): { ok: boolean; error?: string } {
		if (!checkpoint) return { ok: true };
		const result = retainGitCheckpoint(checkpoint);
		return result.ok ? { ok: true } : { ok: false, error: result.error ?? "无法关闭任务检查点。" };
	}

	get current(): GitCheckpoint | undefined {
		return this.checkpoint;
	}

	resetIfNotCreated(): void {
		if (this.checkpoint?.status !== "created") this.checkpoint = undefined;
	}

	private async create(): Promise<void> {
		this.checkpoint = undefined;
		this.host.onEvent({ type: "git_checkpoint_start" });
		this.host.onActivity("正在创建 Git 检查点");
		let ended = false;
		const end = (event: Extract<GitCheckpointLifecycleEvent, { type: "git_checkpoint_end" }>) => {
			if (ended) return;
			ended = true;
			this.host.onEvent(event);
		};

		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			const result = await createGitCheckpoint({
				cwd: this.host.cwd,
				sessionId: this.host.sessionId,
				excludedPaths: this.host.excludedPaths,
			});
			if (!result.ok || !result.checkpoint) {
				throw new Error(["Git：未创建任务检查点，本次修改已阻止。", result.error ?? "未知错误"].join("\n"));
			}
			this.checkpoint = result.checkpoint;
			end({ type: "git_checkpoint_end", ok: true, checkpointId: result.checkpoint.id });
			this.host.onActivity("Git 检查点已创建");
		} catch (error) {
			end({ type: "git_checkpoint_end", ok: false, error: error instanceof Error ? error.message : String(error) });
			this.host.onActivity("Git 检查点创建失败");
			throw error;
		}
	}
}
