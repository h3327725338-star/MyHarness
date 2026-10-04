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
import { DELEGATED_TOOL_NAMES } from "../agent/runtime/role.ts";
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
import { createReadOnlyGuardExtensionSource } from "./shell/read-only-guard.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { FULL_TEXT_OUTPUT } from "./tool-result-persistence.ts";
import { truncateHead } from "./truncate.ts";

const MAX_EXPLORE_TASKS = 18;
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
const REPEATED_OPERATION_THRESHOLD = 3;
const CONSECUTIVE_TOOL_ERROR_THRESHOLD = 3;
const NO_PROGRESS_TURN_THRESHOLD = 3;
const PARTIAL_SUMMARY_CAP = 12 * 1024;
const MAX_STRUCTURED_ITEMS = 24;

const subAgentSchema = Type.Object({
	tasks: Type.Array(
		Type.Object({
			description: Type.String({
				description: "Short name for this independent exploration task",
			}),
			prompt: Type.String({
				description:
					"Clearly describe the investigation scope and the expected findings to check; must not require modifying files",
			}),
			goal: Type.Optional(Type.String({ description: "The bounded question this task must answer" })),
			scope: Type.Optional(
				Type.Array(Type.String(), { description: "Files, modules, or runtime areas that are in scope" }),
			),
			questions: Type.Optional(Type.Array(Type.String(), { description: "Specific questions to answer" })),
			expectedOutput: Type.Optional(Type.String({ description: "Expected evidence-oriented output" })),
			stopConditions: Type.Optional(
				Type.Array(Type.String(), { description: "Conditions for stopping the investigation" }),
			),
		}),
		{
			description: "Independent exploration tasks to run in parallel",
			minItems: 1,
			maxItems: MAX_EXPLORE_TASKS,
		},
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run the Explore tasks in the background so the Main Agent can continue other useful independent work",
		}),
	),
});

export type SubAgentToolInput = Static<typeof subAgentSchema>;
export type SubAgentTaskSpec = SubAgentToolInput["tasks"][number];

export function formatDelegatedTaskPrompt(task: SubAgentTaskSpec): string {
	const sections = [task.prompt];
	if (task.goal) sections.push(`Goal:\n${task.goal}`);
	if (task.scope?.length) sections.push(`Scope:\n${task.scope.map((item) => `- ${item}`).join("\n")}`);
	if (task.questions?.length) sections.push(`Questions:\n${task.questions.map((item) => `- ${item}`).join("\n")}`);
	if (task.expectedOutput) sections.push(`Expected output:\n${task.expectedOutput}`);
	if (task.stopConditions?.length) {
		sections.push(`Stop conditions:\n${task.stopConditions.map((item) => `- ${item}`).join("\n")}`);
	}
	return sections.join("\n\n");
}

export interface SubAgentRuntimeSettings {
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

const INVESTIGATION_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "bash", "symbols"]);

export function hasSuccessfulInvestigationEvidence(transcript: readonly SubAgentToolTrace[]): boolean {
	return transcript.some(
		(entry) => entry.status === "completed" && INVESTIGATION_TOOL_NAMES.has(entry.toolName.toLowerCase()),
	);
}

export type ExploreTaskStatus = "running" | "completed" | "partial" | "failed" | "timeout" | "cancelled";

export type ExploreTaskStopReason =
	| "completed"
	| "max_turns_reached"
	| "no_progress"
	| "stalled"
	| "partial_tool_failure"
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

class SubAgentConvergenceStopError extends Error {
	readonly code = "SUB_AGENT_CONVERGENCE_STOP";
	readonly stopReason: Extract<
		ExploreTaskStopReason,
		"max_turns_reached" | "no_progress" | "stalled" | "partial_tool_failure"
	>;

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

function hasUsefulResult(result: ExploreTaskResult): boolean {
	return (
		hasSuccessfulInvestigationEvidence(result.transcript) ||
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
	systemPromptPath: string;
	guardPath: string;
	signal?: AbortSignal;
	onProgress?: (result: ExploreTaskResult) => void;
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
					...(options.traceContext ? getRuntimeTraceEnvironment(options.traceContext) : {}),
				},
			});
			// 任务 prompt 经 stdin 传入，避免超长命令行触发 ENAMETOOLONG。
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.prompt);
			let buffer = "";
			let settled = false;
			let stopKind:
				| "aborted"
				| "timeout"
				| "max_turns_reached"
				| "no_progress"
				| "stalled"
				| "partial_tool_failure"
				| undefined;
			let stopFinished = false;
			let stopConfirmed = false;
			let taskTimer: NodeJS.Timeout | undefined;
			let stallTimer: NodeJS.Timeout | undefined;
			let progressSinceTurn = false;
			const seenOperationCounts = new Map<string, number>();
			const seenScopes = new Set<string>();
			const seenResultHashes = new Set<string>();
			const seenAssistantHashes = new Set<string>();
			let convergenceWarningIssued = false;
			let toolErrorWarningIssued = false;

			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (taskTimer) clearTimeout(taskTimer);
				if (stallTimer) clearTimeout(stallTimer);
				options.signal?.removeEventListener("abort", onAbort);
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
					if (
						stopKind === "max_turns_reached" ||
						stopKind === "no_progress" ||
						stopKind === "stalled" ||
						stopKind === "partial_tool_failure"
					) {
						const messagesByReason = {
							max_turns_reached: `达到 Sub Agent 最大 turns 限制（${maxTurns}）`,
							no_progress: "连续多轮没有产生新的调查信息",
							stalled: `超过 ${Math.round(stallTimeoutMs / 60_000)} 分钟没有有效进展`,
							partial_tool_failure: "连续多个调查工具调用失败",
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
								: kind === "max_turns_reached"
									? `达到最大 turns（${maxTurns}），正在保留部分结果`
									: "检测到重复或失败的调查操作，正在保留部分结果";
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
						if (
							noProgressDetection &&
							(currentResult.diagnostics?.noProgressTurns ?? 0) >= NO_PROGRESS_TURN_THRESHOLD
						) {
							requestStop("no_progress");
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
						if (event.isError) {
							currentResult.diagnostics!.consecutiveToolErrors += 1;
							pushUniqueLimited(
								currentResult.unresolved,
								`${formatToolCall(event.toolName, toolArgs, options.cwd)}：${resultSummary}`,
							);
							if (
								noProgressDetection &&
								currentResult.diagnostics!.consecutiveToolErrors >= CONSECUTIVE_TOOL_ERROR_THRESHOLD
							) {
								if (!toolErrorWarningIssued) {
									toolErrorWarningIssued = true;
									currentResult.lastToolInfo = "收敛提醒：连续调查工具失败，请更换策略或整理已有证据";
									emitProgress();
								} else {
									requestStop("partial_tool_failure");
								}
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
								if (!convergenceWarningIssued) {
									convergenceWarningIssued = true;
									currentResult.lastToolInfo = `收敛提醒：你似乎在重复已完成的调查，请复用已有证据、更换策略或结束任务（${formatToolCall(event.toolName, toolArgs, options.cwd)}）`;
									emitProgress();
								} else {
									currentResult.lastToolInfo = `检测到重复操作：${formatToolCall(event.toolName, toolArgs, options.cwd)}`;
									requestStop("no_progress");
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
				if (stopKind) {
					stopFinished = true;
					stopConfirmed = true;
					finishStop();
					return;
				}
				settle(() => reject(error));
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
		const convergenceStop =
			stopReason === "max_turns_reached" ||
			stopReason === "no_progress" ||
			stopReason === "stalled" ||
			stopReason === "partial_tool_failure";
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
		const errorMessage =
			stderr.trim() ||
			(childError
				? ((childError as { errorMessage: string }).errorMessage ??
					`Sub-agent process exited with code ${exitCode}`)
				: `Sub-agent process exited with code ${exitCode}`);
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
	if (!hasSuccessfulInvestigationEvidence(currentResult.transcript)) {
		currentResult.status = "failed";
		currentResult.stopReason = "runtime_error";
		currentResult.error = "子 Agent 未执行调查工具，返回内容不能视为完成";
		currentResult.lastToolInfo = currentResult.error;
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
}): string[] {
	return [
		"--internal-delegated-worker",
		"--no-session",
		"--no-context-files",
		"--no-extensions",
		"--extension",
		options.guardPath,
		"--tools",
		DELEGATED_TOOL_NAMES.join(","),
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
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "myharness-sub-agent-"));
	const systemPromptPath = path.join(tempDir, "explore-prompt.md");
	const guardPath = path.join(tempDir, "read-only-guard.js");
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
			(result) => result.status === "completed" || (result.status === "partial" && hasUsefulResult(result)),
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
			fs.promises.writeFile(systemPromptPath, EXPLORE_SYSTEM_PROMPT, { encoding: "utf8", mode: 0o600 }),
			fs.promises.writeFile(
				guardPath,
				createReadOnlyGuardExtensionSource("Sub Agent 已拦截命中的修改型 Bash 命令。", {
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
						cwd: options.cwd,
						provider: options.settings.provider,
						model: options.settings.model,
						thinkingLevel: options.settings.thinkingLevel,
						contextWindow: options.settings.contextWindow,
						description: task.description,
						prompt: taskPrompts[index] ?? task.prompt,
						goal: task.goal ?? task.prompt,
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

		const details: SubAgentToolDetails = {
			completed: results.filter((result) => result.status === "completed").length,
			total: results.length,
			usable: results.filter(
				(result) => result.status === "completed" || (result.status === "partial" && hasUsefulResult(result)),
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
	return {
		name: "agent",
		label: "Agent",
		description:
			"Delegates one to eighteen independent read-only investigation tasks to isolated Explore sub-agents. Suitable when there are multiple genuinely independent directions with parallel payoff; single-path or sequentially dependent investigations are not suitable. Sub-agents cannot modify the project.",
		promptSnippet: loadSystemPrompt("tools/agent/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/agent/guidelines.md"),
		parameters: subAgentSchema,
		// Each call already runs up to 18 tasks in parallel. Serializing separate
		// Agent tool calls keeps the process-wide Explore concurrency capped at 18.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			if (params.tasks.length < 1 || params.tasks.length > MAX_EXPLORE_TASKS) {
				throw new Error(`Agent requires between 1 and ${MAX_EXPLORE_TASKS} Explore tasks.`);
			}
			const settings = options?.getSettings?.() ?? { enabled: false };
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
