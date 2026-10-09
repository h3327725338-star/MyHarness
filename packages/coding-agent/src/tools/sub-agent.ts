import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, ThinkingLevel } from "@myharness/agent-core";
import type { Message } from "@myharness/ai/compat";
import { type Static, Type } from "typebox";
import {
	collectDelegatedEventMessages,
	createDelegatedEventState,
	type DelegatedJsonEvent,
	extractDelegatedMessageToolEvidence,
} from "../agent/delegation/event-parser.ts";
import {
	type DelegatedWorktreeHandle,
	finalizeDelegatedWorktree,
	prepareDelegatedWorktree,
} from "../agent/delegation/worktree-sandbox.ts";
import { DELEGATED_TOOL_NAMES, DELEGATED_WRITE_TOOL_NAMES } from "../agent/runtime/role.ts";
import { SETTINGS_DEFAULTS, SUB_AGENT_SETTING_RANGES } from "../config/settings/defaults.ts";
import type { SubAgentMode } from "../config/settings/types.ts";
import { getAgentDir } from "../config.ts";
import {
	classifyToolStatus,
	getRuntimeTraceEnvironment,
	type RuntimeTrace,
	type RuntimeTraceChildContext,
	type RuntimeTraceScope,
} from "../observability/runtime-trace.ts";
import { loadSystemPrompt, loadSystemPromptLines } from "../system-prompts/loader/index.ts";
import { getMyHarnessInvocation } from "../utils/myharness-invocation.ts";
import { killProcessTreeAndWait } from "../utils/shell.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import { createDelegatedWriteGuardExtensionSource } from "./shell/delegated-write-guard.ts";
import { createReadOnlyGuardExtensionSource, isReadOnlyGuardBlockedToolResult } from "./shell/read-only-guard.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { FULL_TEXT_OUTPUT } from "./tool-result-persistence.ts";
import { truncateHead } from "./truncate.ts";

/** Protocol hard cap for Explore tasks; the user-configurable cap (`subAgent.maxTasks`, default 3) is enforced per call. */
const MAX_EXPLORE_TASKS = SUB_AGENT_SETTING_RANGES.maxTasks.max;
const PER_TASK_OUTPUT_CAP = 20 * 1024;
const SUB_AGENT_STOP_TIMEOUT_MS = 5_000;
/** Zero means delegated Explore tasks have no wall-clock deadline by default. */
export const DEFAULT_SUB_AGENT_TASK_TIMEOUT_MS = 0;
/** Zero means a delegated Explore task may use as many model/tool turns as needed. */
export const DEFAULT_SUB_AGENT_MAX_TURNS = 0;
/** Ten minutes without meaningful progress is a stall by default. */
export const DEFAULT_SUB_AGENT_STALL_TIMEOUT_MS = 10 * 60 * 1_000;
export const DEFAULT_SUB_AGENT_NO_PROGRESS_DETECTION = true;
export const DEFAULT_SUB_AGENT_REPEATED_OPERATION_DETECTION = true;
/** Reminder cadence: re-inject a steering reminder after every N repeats/errors/idle turns. */
const REPEATED_OPERATION_THRESHOLD = 3;
const CONSECUTIVE_TOOL_ERROR_THRESHOLD = 3;
const NO_PROGRESS_TURN_THRESHOLD = 3;
const PARTIAL_SUMMARY_CAP = 12 * 1024;
const MAX_STRUCTURED_ITEMS = 24;

const SUB_AGENT_TASKS_DESCRIPTION = "Independent exploration tasks to run in parallel";
const SUB_AGENT_BACKGROUND_DESCRIPTION =
	"Run the Explore tasks in the background so the Main Agent can continue other useful independent work";

function createSubAgentTaskItemSchema(mode: SubAgentMode) {
	return Type.Object({
		description: Type.String({
			description: "Short name for this independent exploration task",
		}),
		prompt: Type.String({
			description:
				mode === "read-write"
					? "Clearly describe the investigation scope and the changes the sub-agent should make; it edits only inside its own Git worktree and never commits"
					: "Clearly describe the investigation scope and the expected findings to check; must not require modifying files",
		}),
		goal: Type.Optional(Type.String({ description: "The bounded question this task must answer" })),
		scope: Type.Optional(
			Type.Array(Type.String(), { description: "Files, modules, or runtime areas that are in scope" }),
		),
		questions: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Specific questions to answer; the report must answer each one and end with a "## Completion checklist" section, otherwise the task is returned as partial',
			}),
		),
		expectedOutput: Type.Optional(Type.String({ description: "Expected evidence-oriented output" })),
		stopConditions: Type.Optional(
			Type.Array(Type.String(), { description: "Conditions for stopping the investigation" }),
		),
	});
}

function createSubAgentSchemaBody(mode: SubAgentMode) {
	return {
		tasks: Type.Array(createSubAgentTaskItemSchema(mode), {
			description: SUB_AGENT_TASKS_DESCRIPTION,
			minItems: 1,
			maxItems: MAX_EXPLORE_TASKS,
		}),
		run_in_background: Type.Optional(Type.Boolean({ description: SUB_AGENT_BACKGROUND_DESCRIPTION })),
	};
}

const subAgentSchema = Type.Object(createSubAgentSchemaBody("read-only"));

/**
 * The read-only schema object is returned unchanged so the default mode keeps
 * the historical tool protocol byte-for-byte; only the read-write variant
 * re-describes the task prompt field.
 */
function createSubAgentSchema(mode: SubAgentMode): typeof subAgentSchema {
	if (mode !== "read-write") return subAgentSchema;
	return Type.Object(createSubAgentSchemaBody(mode)) as typeof subAgentSchema;
}

export type SubAgentToolInput = Static<typeof subAgentSchema>;
export type SubAgentTaskSpec = SubAgentToolInput["tasks"][number];

export function formatDelegatedTaskPrompt(task: SubAgentTaskSpec): string {
	const sections = [task.prompt];
	if (task.goal) sections.push(`Goal:\n${task.goal}`);
	if (task.scope?.length) sections.push(`Scope:\n${task.scope.map((item) => `- ${item}`).join("\n")}`);
	if (task.questions?.length) {
		sections.push(`Questions:\n${task.questions.map((item) => `- ${item}`).join("\n")}`);
		sections.push(
			"Report requirement: answer every question under Questions item by item in the final report, and end the report with a '## Completion checklist' section containing the two lines '- answered: <number of answered questions>' and '- unanswered: <each unanswered question, separated by semicolons; write none if everything is answered>'. A question that cannot be answered must appear under unanswered together with the missing evidence.",
		);
	}
	if (task.expectedOutput) sections.push(`Expected output:\n${task.expectedOutput}`);
	if (task.stopConditions?.length) {
		sections.push(`Stop conditions:\n${task.stopConditions.map((item) => `- ${item}`).join("\n")}`);
	}
	return sections.join("\n\n");
}

export interface ExploreReportCompleteness {
	complete: boolean;
	unanswered: string[];
	note: string;
}

const UNANSWERED_LINE_PATTERN = /^\s*(?:[-*]\s*)?unanswered\s*[:：]\s*(.*)$/gim;

/**
 * Explore reports for tasks with Questions must end with a self-declared
 * checklist (see system-prompts roles/explore.md). This check trusts only the
 * sub-agent's own declaration: a missing checklist or any declared unanswered
 * item downgrades the task to partial so the Main Agent sees exactly which
 * questions still need work.
 */
export function evaluateExploreReportCompleteness(
	questions: readonly string[] | undefined,
	report: string,
): ExploreReportCompleteness {
	const required = (questions ?? []).map((item) => item.trim()).filter((item) => item !== "");
	if (required.length === 0) return { complete: true, unanswered: [], note: "" };
	const declaredLines = [...report.matchAll(UNANSWERED_LINE_PATTERN)].map((match) => match[1] ?? "");
	if (declaredLines.length === 0) {
		return {
			complete: false,
			unanswered: required,
			note: `报告未提供 Completion checklist 清单，无法确认 ${required.length} 个问题是否逐项回答。`,
		};
	}
	const unanswered = declaredLines
		.flatMap((chunk) => chunk.split(/[;；]+/))
		.map((item) => item.replace(/^[-*\s]+/, "").trim())
		.filter((item) => item !== "" && !/^(none|no|n\/a|-+)$/i.test(item) && item !== "无");
	return unanswered.length === 0
		? { complete: true, unanswered: [], note: "" }
		: {
				complete: false,
				unanswered,
				note: `子 Agent 在报告中声明以下问题未回答：${unanswered.join("；")}。`,
			};
}

export interface SubAgentRuntimeSettings {
	chatMode?: "coding" | "general";
	/** Sub-agent capability mode; anything other than "read-write" keeps the read-only runtime. */
	mode?: SubAgentMode;
	enabled: boolean;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Independent context cap forwarded to the child AgentSession. */
	contextWindow?: number;
	/** Maximum wall-clock duration of one delegated Explore task; zero means no limit. */
	taskTimeoutMs?: number;
	/** Canonical name for the total wall-clock limit; taskTimeoutMs remains supported. */
	totalRuntimeLimitMs?: number;
	/** Maximum model/tool turns; zero means unlimited. */
	maxTurns?: number;
	/** Maximum Explore sub-agents one Agent tool call may start; clamped to 1–18 at runtime. */
	maxTasks?: number;
	/** Maximum time without meaningful progress; zero disables the watchdog. */
	stallTimeoutMs?: number;
	noProgressDetection?: boolean;
	repeatedOperationDetection?: boolean;
}

export type ResolvedSubAgentRuntimeSettings = Required<
	Pick<SubAgentRuntimeSettings, "provider" | "model" | "thinkingLevel">
> &
	Pick<
		SubAgentRuntimeSettings,
		| "mode"
		| "chatMode"
		| "contextWindow"
		| "taskTimeoutMs"
		| "totalRuntimeLimitMs"
		| "maxTurns"
		| "stallTimeoutMs"
		| "noProgressDetection"
		| "repeatedOperationDetection"
	>;

export interface SubAgentToolOptions {
	getSettings?: () => SubAgentRuntimeSettings;
	trace?: RuntimeTrace;
	getTraceParentScope?: () => RuntimeTraceScope | undefined;
	onBackgroundStarted?: (task: SubAgentBackgroundTask) => void;
	onBackgroundProgress?: (progress: SubAgentBackgroundProgress) => void;
	onBackgroundComplete?: (notification: SubAgentBackgroundNotification) => void | Promise<void>;
}

export interface SubAgentBackgroundTask {
	batchId: string;
	cwd: string;
	tasks: SubAgentTaskSpec[];
	settings: ResolvedSubAgentRuntimeSettings;
	abort: () => void;
	promise: Promise<void>;
}

export interface SubAgentBackgroundProgress {
	batchId: string;
	details: SubAgentToolDetails;
}

export interface SubAgentToolTrace {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	status: "running" | "completed" | "failed";
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	errorType?: string;
	resultSummary?: string;
}

const INVESTIGATION_TOOL_NAMES = new Set<string>(DELEGATED_TOOL_NAMES);
const INVESTIGATION_WRITE_TOOL_NAMES = new Set<string>(DELEGATED_WRITE_TOOL_NAMES);

/**
 * A delegated task counts as having done real work when its transcript shows a
 * successful tool call. In read-write mode the write tools are productive work
 * too; the read-only tool set is unchanged.
 */
export function hasSuccessfulInvestigationEvidence(
	transcript: readonly SubAgentToolTrace[],
	mode: SubAgentMode = "read-only",
): boolean {
	const allowed = mode === "read-write" ? INVESTIGATION_WRITE_TOOL_NAMES : INVESTIGATION_TOOL_NAMES;
	return transcript.some((entry) => entry.status === "completed" && allowed.has(entry.toolName.toLowerCase()));
}

export type ExploreTaskStatus = "running" | "completed" | "partial" | "failed" | "timeout" | "cancelled";

export type ExploreTaskStopReason =
	| "completed"
	| "max_turns_reached"
	| "stalled"
	| "incomplete_answer"
	| "context_budget"
	| "timeout"
	| "cancelled"
	| "provider_error"
	| "runtime_error"
	| "user_defined_limit";

export interface ExploreTaskTokenUsage {
	/** Provider-reported usage accumulated from each deduplicated assistant message. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ExploreTaskDiagnostics {
	repeatedOperations: number;
	consecutiveToolErrors: number;
	noProgressTurns: number;
	meaningfulProgressCount: number;
	lastMeaningfulProgressAt?: string;
	lastMeaningfulProgress?: string;
}

export interface ExploreTaskContextTelemetry {
	activeTokens?: number;
	effectiveWindow?: number;
	budgetLimit?: number;
	percent?: number;
	compactions: number;
	lastCompactionReason?: string;
	lastCompactionStatus?: string;
}

export interface ExploreTaskResult {
	description: string;
	prompt: string;
	status: ExploreTaskStatus;
	output: string;
	error?: string;
	model?: string;
	toolUseCount: number;
	/** Sum of input + output + cacheRead + cacheWrite; this is not a current-context estimate. */
	tokens: number;
	tokenUsage?: ExploreTaskTokenUsage;
	turnCount?: number;
	durationMs?: number;
	lastToolInfo?: string;
	lastMeaningfulProgress?: string;
	lastMeaningfulProgressAt?: string;
	stopReason?: ExploreTaskStopReason;
	goal?: string;
	coveredScope?: string[];
	findings?: string[];
	evidence?: string[];
	conflicts?: string[];
	unresolved?: string[];
	recommendedNextInvestigation?: string[];
	diagnostics?: ExploreTaskDiagnostics;
	contextTelemetry?: ExploreTaskContextTelemetry;
	/** Read-write tasks only: own worktree kept because it has uncommitted changes. */
	worktreePath?: string;
	branchName?: string;
	changedFiles?: string[];
	transcript: SubAgentToolTrace[];
	taskId?: string;
	runId?: string;
	parentRunId?: string;
	agentId?: string;
	phaseId?: string;
	workflowRunId?: string;
	/** Internal-only original report. It is deliberately non-enumerable. */
	fullOutput?: string;
}

export interface SubAgentToolDetails {
	completed: number;
	total: number;
	results: ExploreTaskResult[];
	/** Results that can be consumed by a parent: completed plus useful partial results. */
	usable?: number;
	findings?: number;
	model?: string;
	background?: boolean;
	batchId?: string;
}

export interface SubAgentBackgroundNotification {
	batchId: string;
	status: "completed" | "partial" | "failed";
	text: string;
	fullText?: string;
	details?: SubAgentToolDetails;
}

export class SubAgentTaskTimeoutError extends Error {
	readonly code = "SUB_AGENT_TIMEOUT";
	readonly stopReason = "timeout" as const;
	readonly details: { timeoutMs: number };

	constructor(timeoutMs: number) {
		super(`Sub-agent task timed out after ${Math.round(timeoutMs / 1_000)} seconds`);
		this.name = "SubAgentTaskTimeoutError";
		this.details = { timeoutMs };
	}
}

/**
 * Hard convergence stops are limited to genuine non-progress: the stall
 * watchdog, the explicit turn cap, wall-clock timeouts, and cancellation.
 * Repeated operations / consecutive tool failures / idle turns only inject
 * steering reminders into the running child and never terminate it by count.
 */
class SubAgentConvergenceStopError extends Error {
	readonly code = "SUB_AGENT_CONVERGENCE_STOP";
	readonly stopReason: Extract<ExploreTaskStopReason, "max_turns_reached" | "stalled">;

	constructor(stopReason: SubAgentConvergenceStopError["stopReason"], message: string) {
		super(message);
		this.name = "SubAgentConvergenceStopError";
		this.stopReason = stopReason;
	}
}

export function resolvedTaskTimeoutMs(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value >= 0
		? Math.floor(value)
		: DEFAULT_SUB_AGENT_TASK_TIMEOUT_MS;
}

export function resolvedSubAgentMaxTurns(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value >= 0 ? Math.floor(value) : DEFAULT_SUB_AGENT_MAX_TURNS;
}

export function resolvedSubAgentStallTimeoutMs(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value >= 0
		? Math.floor(value)
		: DEFAULT_SUB_AGENT_STALL_TIMEOUT_MS;
}

/** Explore sub-agents one Agent call may start: the configured `subAgent.maxTasks`, clamped to 1–18 (default 3). */
export function resolveExploreMaxTasks(settings?: { maxTasks?: number } | undefined): number {
	const value = settings?.maxTasks;
	if (!Number.isFinite(value) || value === undefined) return SETTINGS_DEFAULTS.defaultSubAgentMaxTasks;
	const { min, max } = SUB_AGENT_SETTING_RANGES.maxTasks;
	return Math.min(Math.max(Math.floor(value), min), max);
}

function resolvedBoolean(value: boolean | undefined, fallback: boolean): boolean {
	return value ?? fallback;
}

function resolveTotalRuntimeLimit(settings: SubAgentRuntimeSettings): number {
	return resolvedTaskTimeoutMs(settings.totalRuntimeLimitMs ?? settings.taskTimeoutMs);
}

export function resolveSubAgentRuntimeSettings(
	settings: SubAgentRuntimeSettings & { enabled?: boolean },
): ResolvedSubAgentRuntimeSettings {
	const totalRuntimeLimitMs = resolveTotalRuntimeLimit(settings);
	return {
		mode: settings.mode === "read-write" ? "read-write" : "read-only",
		chatMode: settings.chatMode,
		provider: settings.provider ?? "",
		model: settings.model ?? "",
		thinkingLevel: settings.thinkingLevel ?? "off",
		contextWindow: settings.contextWindow,
		taskTimeoutMs: totalRuntimeLimitMs,
		totalRuntimeLimitMs,
		maxTurns: resolvedSubAgentMaxTurns(settings.maxTurns),
		stallTimeoutMs: resolvedSubAgentStallTimeoutMs(settings.stallTimeoutMs),
		noProgressDetection: resolvedBoolean(settings.noProgressDetection, DEFAULT_SUB_AGENT_NO_PROGRESS_DETECTION),
		repeatedOperationDetection: resolvedBoolean(
			settings.repeatedOperationDetection,
			DEFAULT_SUB_AGENT_REPEATED_OPERATION_DETECTION,
		),
	};
}

function waitForProcessStop(pid: number | undefined): Promise<boolean> {
	if (!pid) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (confirmed: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(confirmed);
		};
		timer = setTimeout(() => finish(false), SUB_AGENT_STOP_TIMEOUT_MS);
		void killProcessTreeAndWait(pid, SUB_AGENT_STOP_TIMEOUT_MS).then(finish, () => finish(false));
	});
}

const EXPLORE_SYSTEM_PROMPT = loadSystemPrompt("roles/explore.md");
const EXPLORE_WRITE_SYSTEM_PROMPT = loadSystemPrompt("roles/explore-write.md");

function getFinalAssistantText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
	}
	return "";
}

export function truncateSubAgentOutput(output: string): string {
	return truncateHead(output, { maxBytes: PER_TASK_OUTPUT_CAP, maxLines: 500 }).content;
}

function truncateDisplay(value: string, maxLength = 80): string {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatPathForDisplay(value: unknown, cwd: string): string {
	if (typeof value !== "string" || value === "") return ".";
	const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
	const relative = path.relative(cwd, absolute);
	const display = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : value;
	return truncateDisplay(display.replace(/\\/g, "/"), 72);
}

export function formatToolCall(toolName: string, args: Record<string, unknown>, cwd: string): string {
	const normalized = toolName.toLowerCase();
	if (normalized === "read") return `Read(${formatPathForDisplay(args.path ?? args.file_path, cwd)})`;
	if (normalized === "grep") {
		return `Search(pattern: ${JSON.stringify(truncateDisplay(String(args.pattern ?? ""), 48))})`;
	}
	if (normalized === "find") {
		return `Find(pattern: ${JSON.stringify(truncateDisplay(String(args.pattern ?? ""), 48))})`;
	}
	if (normalized === "ls") return `List(${formatPathForDisplay(args.path, cwd)})`;
	if (normalized === "bash") return `Bash(${truncateDisplay(String(args.command ?? "…"), 72)})`;
	return `${toolName}()`;
}

function formatRunningTool(toolName: string, args: Record<string, unknown>, cwd: string): string {
	const normalized = toolName.toLowerCase();
	if (normalized === "read") return `正在读取 ${formatPathForDisplay(args.path ?? args.file_path, cwd)}`;
	if (normalized === "grep") return `正在搜索 ${JSON.stringify(truncateDisplay(String(args.pattern ?? ""), 48))}`;
	if (normalized === "find") return `正在查找 ${JSON.stringify(truncateDisplay(String(args.pattern ?? ""), 48))}`;
	if (normalized === "ls") return `正在列出 ${formatPathForDisplay(args.path, cwd)}`;
	if (normalized === "bash") return `正在执行 ${truncateDisplay(String(args.command ?? "…"), 72)}`;
	return `正在执行 ${toolName}`;
}

function getToolResultText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function summarizeToolResult(toolName: string, result: unknown, isError: boolean): string {
	const text = getToolResultText(result);
	const lines = text === "" ? [] : text.split("\n").filter((line) => line.trim() !== "");
	if (isError) return truncateDisplay(lines.at(-1)?.trim() || "执行失败", 100);
	const normalized = toolName.toLowerCase();
	if (normalized === "read") return `已读取 ${lines.length} 行`;
	if (normalized === "grep") return `找到 ${lines.length} 个匹配项`;
	if (normalized === "find") return `找到 ${lines.length} 个文件`;
	if (normalized === "ls") return `列出 ${lines.length} 个条目`;
	if (normalized === "bash") return truncateDisplay(lines.at(-1)?.trim() || "执行完成", 100);
	return truncateDisplay(lines[0]?.trim() || "执行完成", 100);
}

function reconcileMessageToolEvidence(result: ExploreTaskResult, messages: readonly Message[], cwd: string): void {
	for (const evidence of extractDelegatedMessageToolEvidence(messages)) {
		const trace = result.transcript.find((entry) => entry.toolCallId === evidence.toolCallId);
		const resultSummary = summarizeToolResult(evidence.toolName, evidence.result, evidence.isError);
		if (trace) {
			if (Object.keys(trace.args).length === 0) trace.args = evidence.args;
			if (trace.status === "running") trace.status = evidence.isError ? "failed" : "completed";
			trace.resultSummary ??= resultSummary;
			continue;
		}

		result.toolUseCount += 1;
		result.transcript.push({
			toolCallId: evidence.toolCallId,
			toolName: evidence.toolName,
			args: evidence.args,
			status: evidence.isError ? "failed" : "completed",
			resultSummary,
		});
		result.lastToolInfo = formatToolCall(evidence.toolName, evidence.args, cwd);
	}
}

function getMessageTokens(message: Message): number {
	const usage = getMessageTokenUsage(message);
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getMessageTokenUsage(message: Message): ExploreTaskTokenUsage {
	if (message.role !== "assistant" || !message.usage) {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}
	return {
		input: message.usage.input ?? 0,
		output: message.usage.output ?? 0,
		cacheRead: message.usage.cacheRead ?? 0,
		cacheWrite: message.usage.cacheWrite ?? 0,
	};
}

function addTokenUsage(target: ExploreTaskTokenUsage, addition: ExploreTaskTokenUsage): void {
	target.input += addition.input;
	target.output += addition.output;
	target.cacheRead += addition.cacheRead;
	target.cacheWrite += addition.cacheWrite;
}

function stableStringify(value: unknown): string {
	try {
		return (
			JSON.stringify(value, (_key, item: unknown) => {
				if (!item || typeof item !== "object" || Array.isArray(item)) return item;
				return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
			}) ?? String(value)
		);
	} catch {
		return String(value);
	}
}

function hashValue(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function toolScopeKey(toolName: string, args: Record<string, unknown>, cwd: string): string {
	const normalized = toolName.toLowerCase();
	if (normalized === "read") {
		return `read:${formatPathForDisplay(args.path ?? args.file_path, cwd)}:${String(args.offset ?? 0)}:${String(args.limit ?? "")}`;
	}
	if (normalized === "grep" || normalized === "find") {
		return `${normalized}:${String(args.pattern ?? "")}:${formatPathForDisplay(args.path, cwd)}:${String(args.glob ?? "")}`;
	}
	if (normalized === "ls") return `ls:${formatPathForDisplay(args.path, cwd)}`;
	if (normalized === "symbols") {
		return `symbols:${String(args.operation ?? "")}:${formatPathForDisplay(args.path, cwd)}`;
	}
	if (normalized === "bash") return `bash:${String(args.command ?? "")}`;
	return `${normalized}:${stableStringify(args)}`;
}

function pushUniqueLimited(target: string[] | undefined, value: string, limit = MAX_STRUCTURED_ITEMS): string[] {
	const result = target ?? [];
	const normalized = value.trim();
	if (!normalized || result.includes(normalized)) return result;
	result.push(truncateDisplay(normalized, 600));
	if (result.length > limit) result.splice(0, result.length - limit);
	return result;
}

function assistantText(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function assistantContainsToolCall(message: Message): boolean {
	return message.role === "assistant" && message.content.some((part) => part.type === "toolCall");
}

function collectAssistantFinding(result: ExploreTaskResult, message: Message): void {
	if (assistantContainsToolCall(message)) return;
	const text = assistantText(message);
	if (!text) return;
	result.findings ??= [];
	result.conflicts ??= [];
	for (const line of text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-8)) {
		pushUniqueLimited(result.findings, line, 12);
		if (/冲突|conflict|contradict/i.test(line)) pushUniqueLimited(result.conflicts, line, 8);
	}
}

function applyContextBudgetTelemetry(result: ExploreTaskResult, budget: unknown, reason?: string): void {
	if (!budget || typeof budget !== "object") return;
	const value = budget as Record<string, unknown>;
	const current = result.contextTelemetry ?? { compactions: 0 };
	for (const key of ["activeTokens", "effectiveWindow", "budgetLimit", "percent"] as const) {
		const candidate = value[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) current[key] = candidate;
	}
	if (reason) current.lastCompactionReason = reason;
	result.contextTelemetry = current;
}

function cloneExploreTaskResult(result: ExploreTaskResult): ExploreTaskResult {
	return {
		...result,
		transcript: result.transcript.map((entry) => ({ ...entry, args: { ...entry.args } })),
		coveredScope: result.coveredScope ? [...result.coveredScope] : undefined,
		findings: result.findings ? [...result.findings] : undefined,
		evidence: result.evidence ? [...result.evidence] : undefined,
		conflicts: result.conflicts ? [...result.conflicts] : undefined,
		unresolved: result.unresolved ? [...result.unresolved] : undefined,
		changedFiles: result.changedFiles ? [...result.changedFiles] : undefined,
		recommendedNextInvestigation: result.recommendedNextInvestigation
			? [...result.recommendedNextInvestigation]
			: undefined,
		tokenUsage: result.tokenUsage ? { ...result.tokenUsage } : undefined,
		diagnostics: result.diagnostics ? { ...result.diagnostics } : undefined,
		contextTelemetry: result.contextTelemetry ? { ...result.contextTelemetry } : undefined,
	};
}

function formatProgress(details: SubAgentToolDetails): string {
	const running = details.results.filter((result) => result.status === "running").length;
	const active = details.results.find((result) => result.status === "running" && result.lastToolInfo);
	const activeText = active ? ` · ${active.description}: ${active.lastToolInfo}` : "";
	const usableText = details.usable !== undefined ? `，${details.usable} 个可供主 Agent 使用` : "";
	return `Explore：${details.completed}/${details.total} 已完成${usableText}，${running} 个正在运行${activeText}`;
}

function formatItems(label: string, items: readonly string[] | undefined): string {
	if (!items || items.length === 0) return `${label}: 无\n`;
	return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

function formatTaskReport(result: ExploreTaskResult, full = false): string {
	const status = result.status;
	const body =
		result.output ||
		(status === "failed" || status === "timeout" || status === "cancelled"
			? (result.error ?? "Unknown sub-agent error")
			: "");
	const visibleBody = full ? body : truncateHead(body, { maxBytes: 6 * 1024, maxLines: 160 }).content;
	const diagnostics = result.diagnostics
		? `诊断：重复操作 ${result.diagnostics.repeatedOperations} 次，连续工具错误 ${result.diagnostics.consecutiveToolErrors} 次，无进展轮次 ${result.diagnostics.noProgressTurns} 次\n`
		: "";
	return [
		`### [${result.description}] ${status}${result.stopReason ? ` · ${result.stopReason}` : ""}`,
		`目标：${full ? (result.goal ?? result.prompt) : truncateDisplay(result.goal ?? result.prompt, 1_200)}`,
		`工具调用：${result.toolUseCount} · turns：${result.turnCount ?? 0} · tokens：${result.tokens}`,
		result.worktreePath
			? `读写 Worktree：${result.worktreePath}${result.branchName ? `（分支 ${result.branchName}）` : ""}`
			: "",
		result.changedFiles?.length ? formatItems("改动文件", result.changedFiles) : "",
		result.lastMeaningfulProgress ? `最近有效进展：${result.lastMeaningfulProgress}` : "",
		formatItems("已覆盖范围", result.coveredScope),
		formatItems("已知发现", result.findings),
		formatItems("证据", result.evidence),
		formatItems("冲突", result.conflicts),
		formatItems("未解决", result.unresolved),
		formatItems("建议后续调查", result.recommendedNextInvestigation),
		diagnostics,
		visibleBody ? `报告：\n${visibleBody}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function formatFinalResult(results: ExploreTaskResult[], full = false): string {
	const completed = results.filter((result) => result.status === "completed").length;
	const partial = results.filter((result) => result.status === "partial").length;
	const covered = [...new Set(results.flatMap((result) => result.coveredScope ?? []))].slice(0, MAX_STRUCTURED_ITEMS);
	const unresolved = [...new Set(results.flatMap((result) => result.unresolved ?? []))].slice(0, MAX_STRUCTURED_ITEMS);
	const sections = results.map((result) => formatTaskReport(result, full));
	const formatted = [
		`Explore：${completed}/${results.length} 个任务完成，${partial} 个保留部分结果`,
		formatItems("Covered Scope", covered),
		formatItems("Unresolved Scope", unresolved),
		sections.join("\n\n---\n\n"),
	].join("\n\n");
	return full ? formatted : truncateHead(formatted, { maxBytes: 48 * 1024, maxLines: 1_200 }).content;
}

function collectTranscriptEvidence(result: ExploreTaskResult, cwd: string): void {
	result.coveredScope ??= [];
	result.evidence ??= [];
	for (const trace of result.transcript) {
		if (trace.status !== "completed") continue;
		pushUniqueLimited(result.coveredScope, formatToolCall(trace.toolName, trace.args, cwd));
		pushUniqueLimited(
			result.evidence,
			`${formatToolCall(trace.toolName, trace.args, cwd)}：${trace.resultSummary ?? "执行完成"}`,
		);
	}
}

function hasUsefulResult(result: ExploreTaskResult, mode: SubAgentMode = "read-only"): boolean {
	return (
		hasSuccessfulInvestigationEvidence(result.transcript, mode) ||
		Boolean(result.evidence?.length || result.findings?.length)
	);
}

function partialTaskSummary(result: ExploreTaskResult): string {
	const next = result.recommendedNextInvestigation?.length
		? result.recommendedNextInvestigation.map((item) => `- ${item}`).join("\n")
		: "- 针对未覆盖范围进行定向补查";
	const summary = [
		`状态：${result.status}`,
		`停止原因：${result.stopReason ?? "runtime_error"}`,
		`目标：${result.goal ?? result.prompt}`,
		formatItems("已覆盖范围", result.coveredScope),
		formatItems("已知发现", result.findings),
		formatItems("证据", result.evidence),
		formatItems("冲突", result.conflicts),
		formatItems("未解决", result.unresolved),
		`建议后续调查：\n${next}`,
		result.diagnostics
			? `诊断：重复操作 ${result.diagnostics.repeatedOperations} 次；连续工具错误 ${result.diagnostics.consecutiveToolErrors} 次；无进展轮次 ${result.diagnostics.noProgressTurns} 次`
			: "",
		result.error ? `运行时信息：${result.error}` : "",
	]
		.filter(Boolean)
		.join("\n");
	return truncateSubAgentOutput(
		summary.length > PARTIAL_SUMMARY_CAP ? summary.slice(0, PARTIAL_SUMMARY_CAP) : summary,
	);
}

function finalizePartialResult(
	result: ExploreTaskResult,
	stopReason: ExploreTaskStopReason,
	error: string | undefined,
	cwd: string,
	rawOutput?: string,
): void {
	collectTranscriptEvidence(result, cwd);
	result.stopReason = stopReason;
	result.error = error;
	result.goal ??= result.prompt;
	result.coveredScope ??= [];
	result.findings ??= [];
	result.unresolved ??= [];
	if (error) pushUniqueLimited(result.unresolved, error);
	pushUniqueLimited(result.unresolved, "任务在完成完整调查前停止，未覆盖范围不能视为已确认");
	result.recommendedNextInvestigation ??= [];
	pushUniqueLimited(result.recommendedNextInvestigation, "针对未覆盖范围进行定向补查");
	result.output = partialTaskSummary(result);
	Object.defineProperty(result, "fullOutput", {
		value: rawOutput ? `${result.output}\n\n原始模型输出：\n${rawOutput}` : result.output,
		enumerable: false,
		configurable: true,
	});
}

function stopReasonForError(error: unknown): ExploreTaskStopReason {
	if (error instanceof SubAgentTaskTimeoutError) return "timeout";
	if (error instanceof SubAgentConvergenceStopError) return error.stopReason;
	return "runtime_error";
}

function classifyChildFailure(errorMessage: string, hasProviderError: boolean): ExploreTaskStopReason {
	if (
		/context|context window|token budget|maximum context|too many tokens|上下文|上下文窗口|token 上限/i.test(
			errorMessage,
		)
	) {
		return "context_budget";
	}
	return hasProviderError ? "provider_error" : "runtime_error";
}

async function runExploreTask(options: {
	cwd: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	contextWindow?: number;
	taskTimeoutMs?: number;
	totalRuntimeLimitMs?: number;
	maxTurns?: number;
	stallTimeoutMs?: number;
	noProgressDetection?: boolean;
	repeatedOperationDetection?: boolean;
	description: string;
	prompt: string;
	goal?: string;
	questions?: string[];
	systemPromptPath: string;
	guardPath: string;
	signal?: AbortSignal;
	onProgress?: (result: ExploreTaskResult) => void;
	chatMode?: "coding" | "general";
	/** Capability mode of this task; "read-write" workers run in their own worktree. */
	mode?: SubAgentMode;
	traceContext?: RuntimeTraceChildContext;
}): Promise<ExploreTaskResult> {
	const eventState = createDelegatedEventState();
	const messages = eventState.messages;
	const startedAt = Date.now();
	const currentResult: ExploreTaskResult = {
		description: options.description,
		prompt: options.prompt,
		status: "running",
		output: "",
		model: options.model,
		toolUseCount: 0,
		tokens: 0,
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		turnCount: 0,
		lastToolInfo: "初始化中…",
		goal: options.goal ?? options.prompt,
		coveredScope: [],
		findings: [],
		evidence: [],
		conflicts: [],
		unresolved: [],
		recommendedNextInvestigation: [],
		diagnostics: {
			repeatedOperations: 0,
			consecutiveToolErrors: 0,
			noProgressTurns: 0,
			meaningfulProgressCount: 0,
		},
		contextTelemetry: { compactions: 0 },
		transcript: [],
		...(options.traceContext
			? {
					taskId: options.traceContext.taskId,
					runId: options.traceContext.runId,
					parentRunId: options.traceContext.parentRunId,
					agentId: options.traceContext.agentId,
					phaseId: options.traceContext.phaseId,
					workflowRunId: options.traceContext.workflowRunId,
				}
			: {}),
	};
	const emitProgress = () => options.onProgress?.(cloneExploreTaskResult(currentResult));
	let stderr = "";
	const args = buildSubAgentArgs(options);
	emitProgress();

	const taskTimeoutMs = resolvedTaskTimeoutMs(options.totalRuntimeLimitMs ?? options.taskTimeoutMs);
	const maxTurns = resolvedSubAgentMaxTurns(options.maxTurns);
	const stallTimeoutMs = resolvedSubAgentStallTimeoutMs(options.stallTimeoutMs);
	const noProgressDetection = options.noProgressDetection ?? DEFAULT_SUB_AGENT_NO_PROGRESS_DETECTION;
	const repeatedOperationDetection =
		options.repeatedOperationDetection ?? DEFAULT_SUB_AGENT_REPEATED_OPERATION_DETECTION;
	let stopError: unknown;
	let exitCode = 1;
	try {
		exitCode = await new Promise<number>((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(new Error("Sub-agent execution aborted"));
				return;
			}

			const invocation = getMyHarnessInvocation(args);
			const child = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
				// Match the bash/pwsh tools: never flash a console window on Windows.
				windowsHide: true,
				env: {
					...process.env,
					MYHARNESS_INTERNAL_CHAT_MODE: options.chatMode ?? "coding",
					...(options.mode === "read-write" ? { MYHARNESS_INTERNAL_DELEGATED_MODE: "read-write" } : {}),
					...(options.mode === "read-write" ? { MYHARNESS_INTERNAL_DELEGATED_WORKTREE: options.cwd } : {}),
					...(options.traceContext ? getRuntimeTraceEnvironment(options.traceContext) : {}),
				},
			});
			// 任务 prompt 与运行中提醒都通过 stdin 以 NDJSON 行传入：
			// 避免超长命令行触发 ENAMETOOLONG，并允许向运行中的子会话注入 steering 提醒。
			child.stdin?.on("error", () => {});
			const writeWorkerInput = (payload: { type: "prompt" | "steer"; text: string }) => {
				if (!child.stdin?.writable) return false;
				return child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
			};
			writeWorkerInput({ type: "prompt", text: options.prompt });
			let buffer = "";
			let settled = false;
			let stopKind: "aborted" | "timeout" | "max_turns_reached" | "stalled" | undefined;
			let stopFinished = false;
			let stopConfirmed = false;
			let taskTimer: NodeJS.Timeout | undefined;
			let stallTimer: NodeJS.Timeout | undefined;
			let progressSinceTurn = false;
			const seenOperationCounts = new Map<string, number>();
			const seenScopes = new Set<string>();
			const seenResultHashes = new Set<string>();
			const seenAssistantHashes = new Set<string>();
			const warnedOperationKeys = new Set<string>();
			// Steering reminders reach the running child session through its stdin;
			// they nudge the model but never terminate the task by themselves.
			const injectSteeringReminder = (text: string) => {
				if (settled || stopKind) return;
				currentResult.lastToolInfo = truncateDisplay(text, 160);
				writeWorkerInput({ type: "steer", text });
				emitProgress();
			};

			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (taskTimer) clearTimeout(taskTimer);
				if (stallTimer) clearTimeout(stallTimer);
				options.signal?.removeEventListener("abort", onAbort);
				child.stdin?.end();
				fn();
			};
			const armStallTimer = () => {
				if (stallTimer) clearTimeout(stallTimer);
				if (stallTimeoutMs <= 0 || settled || stopKind) return;
				stallTimer = setTimeout(() => requestStop("stalled"), stallTimeoutMs);
			};
			const markMeaningfulProgress = (description: string) => {
				const timestamp = new Date().toISOString();
				currentResult.lastMeaningfulProgress = truncateDisplay(description, 160);
				currentResult.lastMeaningfulProgressAt = timestamp;
				if (currentResult.diagnostics) {
					currentResult.diagnostics.meaningfulProgressCount += 1;
					currentResult.diagnostics.lastMeaningfulProgress = currentResult.lastMeaningfulProgress;
					currentResult.diagnostics.lastMeaningfulProgressAt = timestamp;
					currentResult.diagnostics.noProgressTurns = 0;
				}
				progressSinceTurn = true;
				armStallTimer();
				emitProgress();
			};
			const finishStop = () => {
				if (!stopKind || !stopFinished) return;
				settle(() => {
					if (stopKind === "timeout") {
						reject(new SubAgentTaskTimeoutError(taskTimeoutMs));
						return;
					}
					if (stopKind === "max_turns_reached" || stopKind === "stalled") {
						const messagesByReason = {
							max_turns_reached: `达到 Sub Agent 最大 turns 限制（${maxTurns}）`,
							stalled: `超过 ${Math.round(stallTimeoutMs / 60_000)} 分钟没有有效进展`,
						} as const;
						reject(new SubAgentConvergenceStopError(stopKind, messagesByReason[stopKind]));
						return;
					}
					const suffix = stopConfirmed ? "" : ", but its process could not be confirmed to have exited";
					reject(new Error(`Sub-agent execution aborted${suffix}`));
				});
			};
			const requestStop = (kind: Exclude<typeof stopKind, undefined>) => {
				if (stopKind) return;
				stopKind = kind;
				currentResult.stopReason = kind === "aborted" ? "cancelled" : kind === "timeout" ? "timeout" : kind;
				currentResult.lastToolInfo =
					kind === "timeout"
						? "执行超时"
						: kind === "aborted"
							? "已取消"
							: kind === "stalled"
								? "检测到长时间没有有效进展，正在停止"
								: `达到最大 turns（${maxTurns}），正在保留部分结果`;
				emitProgress();
				void waitForProcessStop(child.pid).then((confirmed) => {
					stopFinished = true;
					stopConfirmed = confirmed;
					finishStop();
				});
			};
			const processLine = (line: string) => {
				if (!line.trim() || stopKind) return;
				try {
					const event = JSON.parse(line) as DelegatedJsonEvent;
					const addedMessages = collectDelegatedEventMessages(eventState, event);
					for (const message of addedMessages) {
						const usage = getMessageTokenUsage(message);
						addTokenUsage(currentResult.tokenUsage!, usage);
						currentResult.tokens += getMessageTokens(message);
						collectAssistantFinding(currentResult, message);
						const text = assistantText(message);
						if (text && !assistantContainsToolCall(message)) {
							const assistantHash = hashValue(text);
							if (!seenAssistantHashes.has(assistantHash)) {
								seenAssistantHashes.add(assistantHash);
								markMeaningfulProgress("模型产生了新的调查分析");
							}
						}
					}
					if (addedMessages.length > 0) emitProgress();
					if (event.type === "compaction_start") {
						applyContextBudgetTelemetry(currentResult, event.budget, event.reason);
						currentResult.lastToolInfo = `正在压缩 Context（${event.reason ?? "unknown"}）`;
						emitProgress();
					}
					if (event.type === "compaction_end") {
						applyContextBudgetTelemetry(currentResult, event.budget, event.reason);
						if (currentResult.contextTelemetry) {
							currentResult.contextTelemetry.compactions += 1;
							currentResult.contextTelemetry.lastCompactionStatus = event.aborted
								? "aborted"
								: event.errorMessage
									? "failed"
									: "completed";
						}
						currentResult.lastToolInfo = event.errorMessage
							? `Context 压缩失败：${truncateDisplay(event.errorMessage, 100)}`
							: event.aborted
								? "Context 压缩已取消"
								: "Context 压缩完成";
						emitProgress();
					}
					if (event.type === "turn_start" || event.type === "turn_started") {
						currentResult.turnCount = (currentResult.turnCount ?? 0) + 1;
						progressSinceTurn = false;
						if (maxTurns > 0 && currentResult.turnCount > maxTurns) requestStop("max_turns_reached");
						emitProgress();
					}
					if (event.type === "turn_end" || event.type === "turn_finished") {
						if (!progressSinceTurn && currentResult.diagnostics) {
							currentResult.diagnostics.noProgressTurns += 1;
						} else if (currentResult.diagnostics) {
							currentResult.diagnostics.noProgressTurns = 0;
						}
						const idleTurns = currentResult.diagnostics?.noProgressTurns ?? 0;
						if (
							noProgressDetection &&
							idleTurns >= NO_PROGRESS_TURN_THRESHOLD &&
							(idleTurns - NO_PROGRESS_TURN_THRESHOLD) % NO_PROGRESS_TURN_THRESHOLD === 0
						) {
							injectSteeringReminder(
								`收敛提醒：连续 ${idleTurns} 轮没有产生新的调查信息。请更换关键词、路径或工具做针对性检查；如果已有证据足够，请直接整理输出最终报告。`,
							);
						}
						if (maxTurns > 0 && (currentResult.turnCount ?? 0) >= maxTurns) {
							requestStop("max_turns_reached");
						}
						progressSinceTurn = false;
						emitProgress();
					}
					if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
						const toolArgs =
							event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {};
						currentResult.toolUseCount++;
						currentResult.lastToolInfo = formatRunningTool(event.toolName, toolArgs, options.cwd);
						currentResult.transcript.push({
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: toolArgs,
							status: "running",
							startedAt: new Date().toISOString(),
						});
						emitProgress();
					}
					if (event.type === "tool_execution_end" && event.toolCallId && event.toolName) {
						const trace = currentResult.transcript.find((entry) => entry.toolCallId === event.toolCallId);
						const resultSummary = summarizeToolResult(event.toolName, event.result, event.isError ?? false);
						const toolArgs =
							trace?.args ??
							(event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {});
						if (trace) {
							trace.status = event.isError ? "failed" : "completed";
							trace.finishedAt = new Date().toISOString();
							if (trace.startedAt) {
								trace.durationMs = Math.max(0, Date.now() - Date.parse(trace.startedAt));
							}
							trace.errorType = event.isError ? classifyToolStatus(event.result, true) : undefined;
							trace.resultSummary = resultSummary;
						} else {
							currentResult.toolUseCount++;
							currentResult.transcript.push({
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								args: {},
								status: event.isError ? "failed" : "completed",
								finishedAt: new Date().toISOString(),
								errorType: event.isError ? classifyToolStatus(event.result, true) : undefined,
								resultSummary,
							});
						}
						currentResult.lastToolInfo = resultSummary;
						if (event.isError && isReadOnlyGuardBlockedToolResult(event.result)) {
							// 只读守卫拦截：reason 已包含给模型的可执行指引；它不是工具故障，
							// 不计入连续失败数，避免把策略拦截误判成子 Agent 卡死。
						} else if (event.isError) {
							currentResult.diagnostics!.consecutiveToolErrors += 1;
							pushUniqueLimited(
								currentResult.unresolved,
								`${formatToolCall(event.toolName, toolArgs, options.cwd)}：${resultSummary}`,
							);
							const errorStreak = currentResult.diagnostics!.consecutiveToolErrors;
							if (
								noProgressDetection &&
								errorStreak >= CONSECUTIVE_TOOL_ERROR_THRESHOLD &&
								(errorStreak - CONSECUTIVE_TOOL_ERROR_THRESHOLD) % CONSECUTIVE_TOOL_ERROR_THRESHOLD === 0
							) {
								injectSteeringReminder(
									`收敛提醒：连续 ${errorStreak} 次调查工具调用失败。请检查参数与路径是否正确，或改用其他只读工具；必要时基于已有证据输出报告。`,
								);
							}
						} else {
							currentResult.diagnostics!.consecutiveToolErrors = 0;
							const scopeKey = toolScopeKey(event.toolName, toolArgs, options.cwd);
							const operationKey = `${event.toolName.toLowerCase()}:${hashValue(toolArgs)}:${hashValue(event.result)}`;
							const operationCount = (seenOperationCounts.get(operationKey) ?? 0) + 1;
							seenOperationCounts.set(operationKey, operationCount);
							if (operationCount > 1) currentResult.diagnostics!.repeatedOperations += 1;
							const newScope = !seenScopes.has(scopeKey);
							const newResult = !seenResultHashes.has(hashValue(event.result));
							seenScopes.add(scopeKey);
							seenResultHashes.add(hashValue(event.result));
							pushUniqueLimited(
								currentResult.coveredScope,
								formatToolCall(event.toolName, toolArgs, options.cwd),
							);
							pushUniqueLimited(
								currentResult.evidence,
								`${formatToolCall(event.toolName, toolArgs, options.cwd)}：${resultSummary}`,
							);
							if (newScope || newResult)
								markMeaningfulProgress(
									`${formatToolCall(event.toolName, toolArgs, options.cwd)}：${resultSummary}`,
								);
							if (repeatedOperationDetection && operationCount >= REPEATED_OPERATION_THRESHOLD) {
								if (!warnedOperationKeys.has(operationKey)) {
									warnedOperationKeys.add(operationKey);
									injectSteeringReminder(
										`收敛提醒：你似乎在重复已完成的调查（${formatToolCall(event.toolName, toolArgs, options.cwd)}）。请复用已有证据，改用未调查的角度；如果证据已足够，请直接输出最终报告。`,
									);
								} else {
									currentResult.lastToolInfo = `检测到重复操作：${formatToolCall(event.toolName, toolArgs, options.cwd)}`;
									emitProgress();
								}
							}
						}
						emitProgress();
					}
				} catch {
					// Non-JSON diagnostics are reported through stderr/exit status.
				}
			};
			const onAbort = () => requestStop("aborted");

			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (taskTimeoutMs > 0) {
				taskTimer = setTimeout(() => requestStop("timeout"), taskTimeoutMs);
			}
			armStallTimer();
			child.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (data: Buffer) => {
				stderr = truncateSubAgentOutput(stderr + data.toString());
			});
			child.on("error", (error) => {
				// A failed spawn (ENOENT: no node/global myharness on PATH, EACCES...) must say which command
				// could not be started instead of leaking Node's raw errno text as a mysterious runtime_error.
				const code = (error as NodeJS.ErrnoException).code;
				const cause =
					code === "ENOENT"
						? `Cannot start the sub-agent worker: the command "${invocation.command}" was not found`
						: `Cannot start the sub-agent worker ("${invocation.command}")`;
				const wrapped = new Error(`${cause}: ${error.message}`, { cause: error });
				if (stopKind) {
					stopFinished = true;
					stopConfirmed = true;
					finishStop();
					return;
				}
				settle(() => reject(wrapped));
			});
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (stopKind || options.signal?.aborted) {
					if (!stopKind) onAbort();
					if (stopKind && !stopFinished) {
						stopFinished = true;
						stopConfirmed = true;
					}
					finishStop();
					return;
				}
				settle(() => resolve(code ?? 1));
			});
		});
	} catch (error) {
		stopError = error;
	}

	reconcileMessageToolEvidence(currentResult, messages, options.cwd);
	collectTranscriptEvidence(currentResult, options.cwd);
	const fullOutput = getFinalAssistantText(messages);
	const output = truncateSubAgentOutput(fullOutput);
	currentResult.durationMs = Date.now() - startedAt;
	if (currentResult.tokenUsage) {
		currentResult.tokens =
			currentResult.tokenUsage.input +
			currentResult.tokenUsage.output +
			currentResult.tokenUsage.cacheRead +
			currentResult.tokenUsage.cacheWrite;
	}
	if (stopError) {
		const stopReason = stopReasonForError(stopError);
		currentResult.stopReason = stopReason;
		const convergenceStop = stopReason === "max_turns_reached" || stopReason === "stalled";
		currentResult.status =
			stopReason === "timeout"
				? hasUsefulResult(currentResult)
					? "partial"
					: "timeout"
				: stopReason === "cancelled"
					? "cancelled"
					: convergenceStop
						? "partial"
						: "failed";
		currentResult.lastToolInfo =
			stopReason === "timeout"
				? "执行超时"
				: stopReason === "cancelled"
					? "已取消"
					: stopError instanceof Error
						? stopError.message
						: String(stopError);
		if (stopReason === "timeout" && !hasUsefulResult(currentResult)) {
			currentResult.error = stopError instanceof Error ? stopError.message : String(stopError);
		} else if (stopReason === "cancelled" && !hasUsefulResult(currentResult)) {
			currentResult.error = stopError instanceof Error ? stopError.message : String(stopError);
		} else if (stopReason === "runtime_error" && !hasUsefulResult(currentResult)) {
			currentResult.error = stopError instanceof Error ? stopError.message : String(stopError);
		} else {
			if (stopReason === "runtime_error") currentResult.status = "partial";
			finalizePartialResult(
				currentResult,
				stopReason,
				stopError instanceof Error ? stopError.message : String(stopError),
				options.cwd,
				fullOutput,
			);
		}
		emitProgress();
		return currentResult;
	}
	if (exitCode !== 0 || output === "") {
		// Prefer the child's real error message (model request failure, provider
		// error, timeout...) over a generic exit-code string so the parent UI can
		// tell the user what actually went wrong.
		const childError = [...messages]
			.reverse()
			.find(
				(message) =>
					message.role === "assistant" &&
					"errorMessage" in message &&
					typeof (message as { errorMessage?: unknown }).errorMessage === "string" &&
					(message as { errorMessage: string }).errorMessage.length > 0,
			);
		const stderrText = stderr.trim();
		const childErrorMessage =
			stderrText ||
			(childError
				? ((childError as { errorMessage: string }).errorMessage ??
					`Sub-agent process exited with code ${exitCode}`)
				: `Sub-agent process exited with code ${exitCode}`);
		// A child that emitted not a single event never started the task (bad entry,
		// parent/worker version skew, startup crash). Say that plainly instead of
		// handing raw stderr back as if it were the sub-agent's report.
		const errorMessage =
			messages.length === 0
				? `子 Agent 进程未产生任何事件（退出码 ${exitCode}），任务没有真正开始${stderrText ? `；进程输出：${stderrText}` : ""}`
				: childErrorMessage;
		if (hasUsefulResult(currentResult)) {
			currentResult.status = "partial";
			finalizePartialResult(
				currentResult,
				classifyChildFailure(errorMessage, Boolean(childError)),
				errorMessage,
				options.cwd,
				fullOutput,
			);
		} else {
			currentResult.status = "failed";
			currentResult.stopReason = classifyChildFailure(errorMessage, Boolean(childError));
			currentResult.error = errorMessage;
			currentResult.lastToolInfo = currentResult.error;
		}
		emitProgress();
		return currentResult;
	}
	if (!hasSuccessfulInvestigationEvidence(currentResult.transcript, options.mode)) {
		currentResult.status = "failed";
		currentResult.stopReason = "runtime_error";
		currentResult.error = "子 Agent 未执行调查工具，返回内容不能视为完成";
		currentResult.lastToolInfo = currentResult.error;
		emitProgress();
		return currentResult;
	}
	const completeness = evaluateExploreReportCompleteness(options.questions, fullOutput);
	if (!completeness.complete) {
		currentResult.status = "partial";
		currentResult.stopReason = "incomplete_answer";
		currentResult.error = completeness.note;
		currentResult.goal ??= currentResult.prompt;
		for (const item of completeness.unanswered) {
			pushUniqueLimited(currentResult.unresolved, `问题未逐项回答：${item}`);
		}
		currentResult.recommendedNextInvestigation ??= [];
		pushUniqueLimited(currentResult.recommendedNextInvestigation, "针对未回答的问题做定向补查");
		const annotatedOutput = `${fullOutput}\n\n[自动检查] ${completeness.note}`;
		currentResult.output = truncateSubAgentOutput(annotatedOutput);
		Object.defineProperty(currentResult, "fullOutput", {
			value: annotatedOutput,
			enumerable: false,
			configurable: true,
		});
		currentResult.lastToolInfo = "报告未满足问题逐项回答要求，已标记为 partial";
		emitProgress();
		return currentResult;
	}
	currentResult.status = "completed";
	currentResult.output = output;
	currentResult.stopReason = "completed";
	currentResult.goal ??= currentResult.prompt;
	Object.defineProperty(currentResult, "fullOutput", {
		value: fullOutput,
		enumerable: false,
		configurable: true,
	});
	currentResult.lastToolInfo = "完成";
	emitProgress();
	return currentResult;
}

export function buildSubAgentArgs(options: {
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	contextWindow?: number;
	systemPromptPath: string;
	guardPath: string;
	mode?: SubAgentMode;
}): string[] {
	const toolNames = options.mode === "read-write" ? DELEGATED_WRITE_TOOL_NAMES : DELEGATED_TOOL_NAMES;
	return [
		"--internal-delegated-worker",
		"--no-session",
		"--no-context-files",
		"--no-extensions",
		"--extension",
		options.guardPath,
		"--tools",
		toolNames.join(","),
		"--model",
		`${options.provider}/${options.model}`,
		"--thinking",
		options.thinkingLevel,
		"--agent-role",
		"delegated",
		...(options.contextWindow !== undefined ? ["--context-window", String(options.contextWindow)] : []),
		"--append-system-prompt",
		options.systemPromptPath,
	];
}

export interface RunExploreBatchOptions {
	cwd: string;
	tasks: SubAgentTaskSpec[];
	settings: ResolvedSubAgentRuntimeSettings;
	signal?: AbortSignal;
	onProgress?: (details: SubAgentToolDetails) => void;
	/**
	 * Called once before tasks start. The provided callback aborts the task at
	 * the given index (kills its sub-agent process); other tasks keep running.
	 */
	onKillReady?: (killTask: (index: number) => void) => void;
	trace?: RuntimeTrace;
	parentTraceScope?: RuntimeTraceScope;
	phaseId?: string;
	workflowRunId?: string;
}

export interface ExploreBatchResult {
	text: string;
	fullText: string;
	details: SubAgentToolDetails;
}

export async function runExploreBatch(options: RunExploreBatchOptions): Promise<ExploreBatchResult> {
	const mode: SubAgentMode = options.settings.mode === "read-write" ? "read-write" : "read-only";
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "myharness-sub-agent-"));
	const systemPromptPath = path.join(tempDir, "explore-prompt.md");
	const guardPath = path.join(tempDir, mode === "read-write" ? "delegated-write-guard.js" : "read-only-guard.js");
	const taskPrompts = options.tasks.map(formatDelegatedTaskPrompt);
	const parentTraceScope = options.parentTraceScope;
	const taskTraceContexts = options.tasks.map((task) => {
		if (!options.trace || !parentTraceScope) return undefined;
		return {
			task,
			context: options.trace.createChildContext(parentTraceScope, {
				role: "delegated",
				agentId: options.trace.createId("agent"),
				taskId: options.trace.createId("task"),
				phaseId: options.phaseId ?? parentTraceScope.phaseId,
				workflowRunId: options.workflowRunId ?? parentTraceScope.workflowRunId,
			}),
		};
	});
	const results: ExploreTaskResult[] = options.tasks.map((task, index) => ({
		description: task.description,
		prompt: taskPrompts[index] ?? task.prompt,
		status: "running",
		output: "",
		model: options.settings.model,
		toolUseCount: 0,
		tokens: 0,
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		turnCount: 0,
		lastToolInfo: "初始化中…",
		goal: task.goal ?? task.prompt,
		coveredScope: [],
		findings: [],
		evidence: [],
		conflicts: [],
		unresolved: [],
		recommendedNextInvestigation: [],
		diagnostics: {
			repeatedOperations: 0,
			consecutiveToolErrors: 0,
			noProgressTurns: 0,
			meaningfulProgressCount: 0,
		},
		contextTelemetry: { compactions: 0 },
		transcript: [],
	}));
	const emitProgress = () => {
		const usable = results.filter(
			(result) => result.status === "completed" || (result.status === "partial" && hasUsefulResult(result, mode)),
		).length;
		options.onProgress?.({
			completed: results.filter((result) => result.status === "completed").length,
			total: results.length,
			usable,
			findings: results.reduce((count, result) => count + (result.findings?.length ?? 0), 0),
			results: results.map(cloneExploreTaskResult),
		});
	};

	try {
		for (let index = 0; index < taskTraceContexts.length; index++) {
			const traceTask = taskTraceContexts[index];
			if (!traceTask || !options.trace || !parentTraceScope) continue;
			results[index] = {
				...results[index],
				taskId: traceTask.context.taskId,
				runId: traceTask.context.runId,
				parentRunId: traceTask.context.parentRunId,
				agentId: traceTask.context.agentId,
				phaseId: traceTask.context.phaseId,
				workflowRunId: traceTask.context.workflowRunId,
			};
			await options.trace.record(parentTraceScope, "task-started", {
				taskId: traceTask.context.taskId,
				childRunId: traceTask.context.runId,
				agentId: traceTask.context.agentId,
				description: traceTask.task.description,
				maxTurns: resolvedSubAgentMaxTurns(options.settings.maxTurns),
				stallTimeoutMs: resolvedSubAgentStallTimeoutMs(options.settings.stallTimeoutMs),
				totalRuntimeLimitMs: resolvedTaskTimeoutMs(
					options.settings.totalRuntimeLimitMs ?? options.settings.taskTimeoutMs,
				),
			});
		}
		await Promise.all([
			fs.promises.writeFile(
				systemPromptPath,
				mode === "read-write" ? EXPLORE_WRITE_SYSTEM_PROMPT : EXPLORE_SYSTEM_PROMPT,
				{ encoding: "utf8", mode: 0o600 },
			),
			fs.promises.writeFile(
				guardPath,
				mode === "read-write"
					? createDelegatedWriteGuardExtensionSource()
					: createReadOnlyGuardExtensionSource("Sub Agent 已拦截命中的修改型 Bash 命令。", {
							mode: "delegated",
							adjudicator: {
								provider: options.settings.provider,
								model: options.settings.model,
							},
						}),
				{ encoding: "utf8", mode: 0o600 },
			),
		]);
		emitProgress();
		// Read-write tasks each run inside their own fresh Git worktree, created
		// up front so an unusable workspace fails the whole dispatch with a clear
		// reason instead of after some workers already started.
		const worktreeHandles: Array<DelegatedWorktreeHandle | undefined> = options.tasks.map(() => undefined);
		if (mode === "read-write") {
			for (let index = 0; index < options.tasks.length; index++) {
				const prepared = prepareDelegatedWorktree({ cwd: options.cwd, agentDir: getAgentDir() });
				if (!prepared.ok) {
					for (const handle of worktreeHandles) {
						if (handle) finalizeDelegatedWorktree(handle);
					}
					throw new Error(`无法派出读写子代理：${prepared.error}`);
				}
				worktreeHandles[index] = prepared.handle;
			}
		}
		// Per-task abort controllers: the panel can kill a single Explore task
		// while the rest of the batch keeps running.
		const taskControllers = options.tasks.map(() => new AbortController());
		const lastProgressAt = options.tasks.map(() => undefined as string | undefined);
		options.onKillReady?.((index) => taskControllers[index]?.abort());
		const taskSettlements = await Promise.allSettled(
			options.tasks.map(async (task, index) => {
				const traceContext = taskTraceContexts[index]?.context;
				try {
					results[index] = await runExploreTask({
						cwd:
							mode === "read-write" && worktreeHandles[index]
								? worktreeHandles[index].worktreePath
								: options.cwd,
						provider: options.settings.provider,
						model: options.settings.model,
						chatMode: options.settings.chatMode,
						mode,
						thinkingLevel: options.settings.thinkingLevel,
						contextWindow: options.settings.contextWindow,
						description: task.description,
						prompt: taskPrompts[index] ?? task.prompt,
						goal: task.goal ?? task.prompt,
						questions: task.questions,
						systemPromptPath,
						guardPath,
						signal: options.signal
							? AbortSignal.any([options.signal, taskControllers[index].signal])
							: taskControllers[index].signal,
						taskTimeoutMs: options.settings.taskTimeoutMs,
						totalRuntimeLimitMs: options.settings.totalRuntimeLimitMs,
						maxTurns: options.settings.maxTurns,
						stallTimeoutMs: options.settings.stallTimeoutMs,
						noProgressDetection: options.settings.noProgressDetection,
						repeatedOperationDetection: options.settings.repeatedOperationDetection,
						traceContext,
						onProgress: (result) => {
							results[index] = result;
							if (
								options.trace &&
								parentTraceScope &&
								traceContext &&
								result.lastMeaningfulProgressAt &&
								lastProgressAt[index] !== result.lastMeaningfulProgressAt
							) {
								lastProgressAt[index] = result.lastMeaningfulProgressAt;
								void options.trace
									.record(parentTraceScope, "task-progress", {
										taskId: traceContext.taskId,
										childRunId: traceContext.runId,
										toolUseCount: result.toolUseCount,
										turnCount: result.turnCount,
										tokens: result.tokens,
										findings: result.findings?.length ?? 0,
										lastMeaningfulProgress: result.lastMeaningfulProgress,
										lastMeaningfulProgressAt: result.lastMeaningfulProgressAt,
									})
									.catch(() => {});
							}
							emitProgress();
						},
					});
					if (options.trace && parentTraceScope && traceContext) {
						await options.trace.record(parentTraceScope, "task-finished", {
							taskId: traceContext.taskId,
							childRunId: traceContext.runId,
							status: results[index].status,
							toolUseCount: results[index].toolUseCount,
							turnCount: results[index].turnCount,
							tokens: results[index].tokens,
							stopReason: results[index].stopReason,
							findings: results[index].findings?.length ?? 0,
							durationMs: results[index].durationMs,
						});
					}
					emitProgress();
				} catch (error) {
					const timeout = error instanceof SubAgentTaskTimeoutError;
					const cancelled = taskControllers[index]?.signal.aborted === true || options.signal?.aborted === true;
					const status: ExploreTaskStatus = timeout ? "timeout" : cancelled ? "cancelled" : "failed";
					const message = timeout
						? error.message
						: taskControllers[index]?.signal.aborted
							? "已手动中止"
							: options.signal?.aborted
								? "父任务已取消"
								: error instanceof Error
									? error.message
									: String(error);
					results[index] = {
						...results[index],
						status,
						error: message,
						lastToolInfo: status === "timeout" ? "执行超时" : status === "cancelled" ? "已取消" : message,
					};
					emitProgress();
					if (options.trace && parentTraceScope && traceContext) {
						await options.trace.record(parentTraceScope, "task-finished", {
							taskId: traceContext.taskId,
							childRunId: traceContext.runId,
							status,
							error: message,
							stopReason: timeout ? "timeout" : cancelled ? "cancelled" : "runtime_error",
							toolUseCount: results[index].toolUseCount,
							turnCount: results[index].turnCount,
							tokens: results[index].tokens,
						});
					}
				}
			}),
		);
		let normalizedRejectedTask = false;
		for (let index = 0; index < taskSettlements.length; index++) {
			const settlement = taskSettlements[index];
			if (settlement.status !== "rejected" || results[index].status !== "running") continue;
			const message = settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
			results[index] = {
				...results[index],
				status: "failed",
				stopReason: "runtime_error",
				error: message,
				lastToolInfo: message,
			};
			normalizedRejectedTask = true;
		}
		if (normalizedRejectedTask) emitProgress();

		// Finalize every read-write worktree: clean ones are removed automatically,
		// anything with uncommitted or untracked changes is kept and reported.
		if (mode === "read-write") {
			for (let index = 0; index < worktreeHandles.length; index++) {
				const handle = worktreeHandles[index];
				if (!handle) continue;
				const finalized = finalizeDelegatedWorktree(handle);
				if (finalized.dirty) {
					results[index] = {
						...results[index],
						worktreePath: handle.worktreePath,
						branchName: handle.branchName,
						changedFiles: finalized.changedFiles,
					};
					if (finalized.error) {
						results[index].unresolved = pushUniqueLimited(results[index].unresolved, finalized.error);
					}
				}
			}
			emitProgress();
		}

		const details: SubAgentToolDetails = {
			completed: results.filter((result) => result.status === "completed").length,
			total: results.length,
			usable: results.filter(
				(result) => result.status === "completed" || (result.status === "partial" && hasUsefulResult(result, mode)),
			).length,
			findings: results.reduce((count, result) => count + (result.findings?.length ?? 0), 0),
			results: results.map(cloneExploreTaskResult),
			model: options.settings.model,
		};
		const fullResults = results.map((result) => ({
			...result,
			output: result.fullOutput ?? result.output,
		}));
		return {
			text: formatFinalResult(results),
			fullText: formatFinalResult(fullResults, true),
			details,
		};
	} finally {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	}
}

export function createSubAgentToolDefinition(
	cwd: string,
	options?: SubAgentToolOptions,
): BusinessToolDefinition<typeof subAgentSchema, SubAgentToolDetails> {
	const settingsSnapshot = options?.getSettings?.();
	const mode: SubAgentMode = settingsSnapshot?.mode === "read-write" ? "read-write" : "read-only";
	const advertisedMaxTasks = resolveExploreMaxTasks(settingsSnapshot);
	const promptVariables = { maxTasks: String(advertisedMaxTasks), capability: mode };
	return {
		name: "agent",
		label: "Agent",
		description:
			mode === "read-write"
				? `Delegates one to ${advertisedMaxTasks} independent investigation tasks to isolated Explore sub-agents. Suitable when there are multiple genuinely independent directions with parallel payoff; single-path or sequentially dependent investigations are not suitable. Each sub-agent may edit files and run commands only inside its own Git worktree (a separate checkout kept under the settings directory); it can never commit, push, merge or stage, cannot start further sub-agents, and reports its worktree path, branch and changed files back with the result. Changes stay uncommitted for the Main Agent and the user to review.`
				: `Delegates one to ${advertisedMaxTasks} independent read-only investigation tasks to isolated Explore sub-agents. Suitable when there are multiple genuinely independent directions with parallel payoff; single-path or sequentially dependent investigations are not suitable. Sub-agents cannot modify the project.`,
		promptSnippet: loadSystemPrompt("tools/agent/snippet.md", promptVariables),
		promptGuidelines: [
			...loadSystemPromptLines("tools/agent/guidelines.md", promptVariables),
			...(mode === "read-write"
				? [
						"Read-write Explore sub-agents edit only inside their own Git worktree, never commit, push, merge or stage, and never start further sub-agents; their result reports the worktree path, branch and changed files.",
					]
				: []),
		],
		parameters: createSubAgentSchema(mode),
		// Each call already runs its tasks in parallel, capped by the configured subAgent.maxTasks. Serializing
		// separate Agent tool calls keeps the process-wide Explore concurrency at that same cap. The schema keeps
		// MAX_EXPLORE_TASKS as the protocol hard cap; execute enforces the live configured value below it.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			const settings = options?.getSettings?.() ?? { enabled: false };
			const maxTasks = resolveExploreMaxTasks(settings);
			if (params.tasks.length < 1 || params.tasks.length > maxTasks) {
				throw new Error(`Agent requires between 1 and ${maxTasks} Explore tasks.`);
			}
			if (!settings.enabled) throw new Error("Sub Agent is disabled in /settings.");
			if (!settings.provider || !settings.model || !settings.thinkingLevel) {
				throw new Error("Sub Agent model or thinking level is not configured. Configure it in /settings.");
			}
			const runtimeSettings = resolveSubAgentRuntimeSettings(settings);
			const parentTraceScope = options?.getTraceParentScope?.();

			if (params.run_in_background) {
				const batchId = `explore-${randomBytes(5).toString("hex")}`;
				const controller = new AbortController();
				const initialDetails: SubAgentToolDetails = {
					completed: 0,
					total: params.tasks.length,
					background: true,
					batchId,
					results: params.tasks.map((task) => ({
						description: task.description,
						prompt: formatDelegatedTaskPrompt(task),
						status: "running",
						output: "",
						toolUseCount: 0,
						tokens: 0,
						lastToolInfo: "后台运行中…",
						transcript: [],
					})),
				};
				const promise = runExploreBatch({
					cwd,
					tasks: params.tasks,
					settings: runtimeSettings,
					signal: controller.signal,
					trace: options?.trace,
					parentTraceScope,
					onProgress: (details) => options?.onBackgroundProgress?.({ batchId, details }),
				})
					.then(async (result) => {
						await options?.onBackgroundComplete?.({
							batchId,
							status: result.details.results.some(
								(item) => item.status === "failed" || item.status === "cancelled" || item.status === "timeout",
							)
								? "failed"
								: result.details.results.some((item) => item.status === "partial")
									? "partial"
									: "completed",
							text: result.text,
							fullText: result.fullText,
							details: { ...result.details, background: true, batchId },
						});
					})
					.catch(async (error) => {
						const message = error instanceof Error ? error.message : String(error);
						try {
							await options?.onBackgroundComplete?.({
								batchId,
								status: "failed",
								text: `后台 Explore ${batchId} 失败：${message}`,
							});
						} catch {
							// Completion notification failure must not create an unhandled background rejection.
						}
					});
				options?.onBackgroundStarted?.({
					batchId,
					cwd,
					tasks: params.tasks.map((task) => ({ ...task })),
					settings: runtimeSettings,
					abort: () => controller.abort(),
					promise,
				});
				return {
					content: [
						{
							type: "text",
							text: `已启动后台 Explore ${batchId}（${params.tasks.length} 个任务）。完成结果会自动通知主 Agent。`,
						},
					],
					details: initialDetails,
				};
			}

			const result = await runExploreBatch({
				cwd,
				tasks: params.tasks,
				settings: runtimeSettings,
				signal,
				trace: options?.trace,
				parentTraceScope,
				onProgress: (details) => {
					onUpdate?.({ content: [{ type: "text", text: formatProgress(details) }], details });
				},
			});
			const toolResult = { content: [{ type: "text" as const, text: result.text }], details: result.details };
			if (result.fullText !== result.text) {
				Object.assign(toolResult, { [FULL_TEXT_OUTPUT]: result.fullText });
			}
			return toolResult;
		},
	};
}

export function createSubAgentTool(cwd: string, options?: SubAgentToolOptions): AgentTool<typeof subAgentSchema> {
	return wrapToolDefinition(createSubAgentToolDefinition(cwd, options));
}
