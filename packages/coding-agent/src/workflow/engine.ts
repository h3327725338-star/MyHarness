import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import type { SubAgentMode } from "../config/settings/types.ts";
import type { RuntimeTrace, RuntimeTraceScope } from "../observability/runtime-trace.ts";
import type { BusinessToolDefinition } from "../tools/contracts/index.ts";
import { awaitForegroundDispatch, type DispatchRegistrar } from "../tools/dispatch-control.ts";
import {
	DEFAULT_SUB_AGENT_TASK_TIMEOUT_MS,
	type ExploreBatchResult,
	type ExploreTaskResult,
	hasSuccessfulInvestigationEvidence,
	type ResolvedSubAgentRuntimeSettings,
	type RunExploreBatchOptions,
	resolveExploreMaxTasks,
	resolveSubAgentRuntimeSettings,
	runExploreBatch,
	type SubAgentRuntimeSettings,
} from "../tools/sub-agent.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { FULL_TEXT_OUTPUT } from "../tools/tool-result-persistence.ts";
import { INVESTIGATION_TOOL_PROFILES, type InvestigationToolKind } from "../ultracode/profile.ts";

function createInvestigationTaskSchema(mode: SubAgentMode) {
	return Type.Object({
		description: Type.String({
			description:
				mode === "read-write"
					? "Short name for this investigation task"
					: "Short name for this read-only investigation task",
		}),
		prompt: Type.String({
			description:
				mode === "read-write"
					? "Clearly describe the investigation scope, the facts to confirm, and the evidence to return; in the current read-write mode a task may also ask the sub-agent to edit files or run commands, but only inside its own Git worktree and it never commits"
					: "Clearly describe the investigation scope, the facts to confirm, and the evidence to return; must not require modifying files",
		}),
		goal: Type.Optional(Type.String({ description: "The bounded question this task must answer" })),
		scope: Type.Optional(Type.Array(Type.String(), { description: "Files, modules, or runtime areas in scope" })),
		questions: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Specific questions to answer; the report must answer each one and end with a "## Completion checklist" section, otherwise the task is returned as partial',
			}),
		),
		expectedOutput: Type.Optional(Type.String({ description: "Expected evidence-oriented output" })),
		stopConditions: Type.Optional(Type.Array(Type.String(), { description: "Conditions for stopping" })),
	});
}

function createInvestigationPhaseSchema(mode: SubAgentMode, maxTasks: number) {
	return Type.Object({
		name: Type.String({
			description: 'Phase name, e.g. "Investigate", "Verify", "Cross-check"',
		}),
		tasks: Type.Array(createInvestigationTaskSchema(mode), {
			description:
				mode === "read-write"
					? `Explore tasks run in parallel within this phase；当前单阶段上限为${maxTasks}个`
					: `Read-only Explore tasks run in parallel within this phase；当前单阶段上限为${maxTasks}个`,
			minItems: 1,
			maxItems: maxTasks,
		}),
	});
}

function createInvestigationSchema(
	minPhases: number,
	mode: SubAgentMode = "read-only",
	maxTasks: number = resolveExploreMaxTasks(),
) {
	return Type.Object({
		name: Type.String({
			description: "Short name for the workflow",
		}),
		phases: Type.Array(createInvestigationPhaseSchema(mode, maxTasks), {
			description: "Phases executed in order; each phase may run multiple tasks in parallel",
			minItems: minPhases,
		}),
	});
}

const workflowSchema = createInvestigationSchema(1, "read-only", resolveExploreMaxTasks());
const ultracodeSchema = createInvestigationSchema(2, "read-only", resolveExploreMaxTasks());
const WORKFLOW_DEADLINE_GRACE_MS = 30 * 1_000;
const WORKFLOW_BATCH_DRAIN_TIMEOUT_MS = 5_000;

export type WorkflowToolInput = Static<typeof workflowSchema>;
export type UltracodeToolInput = Static<typeof ultracodeSchema>;

export type { InvestigationToolKind } from "../ultracode/profile.ts";

type InvestigationSchema<K extends InvestigationToolKind> = K extends "ultracode"
	? typeof ultracodeSchema
	: typeof workflowSchema;

export type WorkflowTerminalStatus = "completed" | "partial" | "failed" | "timeout" | "cancelled";
export type WorkflowPhaseStatus = "pending" | "running" | WorkflowTerminalStatus;

export interface WorkflowPhaseDetails {
	name: string;
	phaseId?: string;
	status: WorkflowPhaseStatus;
	completed: number;
	total: number;
	usable?: number;
	findings?: number;
	results: ExploreTaskResult[];
}

export interface WorkflowToolDetails {
	name: string;
	workflowRunId?: string;
	model?: string;
	status: "running" | WorkflowTerminalStatus;
	activePhase: number;
	phases: WorkflowPhaseDetails[];
	/** Session registry id of this run (see tools/dispatch-control.ts). */
	batchId?: string;
	/** The run was moved to the background when the main run was interrupted. */
	background?: boolean;
}

export type UltracodeToolDetails = WorkflowToolDetails;

class WorkflowTimeoutError extends Error {
	readonly code = "WORKFLOW_TIMEOUT";

	constructor(scope: "phase" | "workflow") {
		super(`${scope === "phase" ? "Workflow phase" : "Workflow"} timed out`);
		this.name = "WorkflowTimeoutError";
	}
}

/**
 * Runtime cancellation controls for an in-flight workflow.
 * The session uses these to abort active runs; callers can also cancel
 * individual tasks of the currently executing phase.
 */
export interface WorkflowToolControls {
	killTask: (phaseIndex: number, taskIndex: number) => void;
	killWorkflow: () => void;
}

export interface WorkflowToolOptions {
	getSettings?: () => SubAgentRuntimeSettings;
	runBatch?: (options: RunExploreBatchOptions) => Promise<ExploreBatchResult>;
	/** Grace added above the per-task timeout for phase/workflow deadlines. */
	deadlineGraceMs?: number;
	trace?: RuntimeTrace;
	getTraceParentScope?: () => RuntimeTraceScope | undefined;
	/** Called with the tool call id while the workflow is executing. */
	onControlsReady?: (toolCallId: string, controls: WorkflowToolControls) => void;
	/** Called when the workflow finished (success, failure or abort). */
	onControlsRelease?: (toolCallId: string) => void;
	/** Registers the run with the session, which can stop it or move it to the background. */
	dispatch?: DispatchRegistrar;
}

export type UltracodeToolOptions = WorkflowToolOptions;

function cloneResult(result: ExploreTaskResult): ExploreTaskResult {
	return {
		...result,
		transcript: result.transcript.map((trace) => ({ ...trace, args: { ...trace.args } })),
	};
}

function cloneDetails(details: WorkflowToolDetails): WorkflowToolDetails {
	return {
		...details,
		phases: details.phases.map((phase) => ({
			...phase,
			results: phase.results.map(cloneResult),
		})),
	};
}

function isUsableTaskResult(result: ExploreTaskResult, mode: SubAgentMode): boolean {
	if (result.status === "completed") return true;
	if (result.status !== "partial" && result.status !== "timeout") return false;
	return (
		hasSuccessfulInvestigationEvidence(result.transcript, mode) ||
		Boolean(result.evidence?.length || result.findings?.length)
	);
}

function phaseFailureStatus(results: ExploreTaskResult[], parentCancelled = false): WorkflowTerminalStatus {
	if (parentCancelled || results.some((task) => task.status === "cancelled")) return "cancelled";
	if (results.some((task) => task.status === "timeout")) return "timeout";
	return "failed";
}

function finalizeUnsettledPhaseTasks(
	phase: WorkflowPhaseDetails,
	tasks: WorkflowToolInput["phases"][number]["tasks"],
	status: Exclude<WorkflowTerminalStatus, "completed">,
	error: string,
	model: string | undefined,
	mode: SubAgentMode,
): void {
	phase.results = tasks.map((task, index) => {
		const current = phase.results[index];
		if (current && current.status !== "running") return cloneResult(current);
		return {
			...(current ?? {
				description: task.description,
				prompt: task.prompt,
				output: "",
				model,
				toolUseCount: 0,
				tokens: 0,
				transcript: [],
			}),
			status,
			stopReason: status === "timeout" ? "timeout" : status === "cancelled" ? "cancelled" : "runtime_error",
			error,
			lastToolInfo: status === "timeout" ? "执行超时" : status === "cancelled" ? "已取消" : error,
		};
	});
	phase.completed = phase.results.filter((task) => task.status === "completed").length;
	phase.usable = phase.results.filter((task) => isUsableTaskResult(task, mode)).length;
	phase.findings = phase.results.reduce((count, task) => count + (task.findings?.length ?? 0), 0);
}

function formatProgress(details: WorkflowToolDetails, label: string): string {
	const phase = details.phases[details.activePhase];
	if (!phase) return `${label}: ${details.name}`;
	const usable = phase.usable === undefined ? "" : ` · 可用 ${phase.usable}`;
	const active = phase.results.find((result) => result.status === "running" && result.lastToolInfo);
	return `${label}: ${details.name} · ${phase.name} ${phase.completed}/${phase.total}${usable}${active ? ` · ${active.lastToolInfo}` : ""}`;
}

function formatFinalOutput(
	label: string,
	name: string,
	phaseOutputs: Array<{ name: string; text: string }>,
	status: WorkflowTerminalStatus = "completed",
): string {
	return [
		`${label} "${name}" ${status}.`,
		...phaseOutputs.flatMap((phase) => [`\n## ${phase.name}\n`, phase.text]),
	].join("\n");
}

function appendPreviousPhaseContext(
	prompt: string,
	previousPhase: { name: string; filePath: string } | undefined,
): string {
	if (!previousPhase) return prompt;
	return `${prompt}

The structured, bounded results of the previous phase "${previousPhase.name}" were saved to a file:
<previous_phase_results_file>${previousPhase.filePath}</previous_phase_results_file>

Read this summary before starting. Use its findings, evidence, conflicts, covered scope, and unresolved items as the starting point. Do not rescan the whole repository; only perform targeted checks for unresolved or conflicting points.`;
}

/**
 * Read-write capability wording for the shared investigation tool prompts.
 * The read-only mode keeps every historical string untouched; only read-write
 * re-describes the clauses that would otherwise forbid sub-agent edits.
 */
const READ_WRITE_CAPABILITY_WORDING: ReadonlyArray<readonly [string, string]> = [
	["multiple read-only Explores", "multiple Explores"],
	[
		"sub-agents may not modify files or create further agents",
		"sub-agents never start further agents; in the current read-write mode each may edit only inside its own Git worktree and never commits or pushes",
	],
	["read-only multi-Agent workflow", "multi-Agent workflow"],
	["read-only workflow for complex tasks", "workflow for complex tasks"],
	["multiple nonoverlapping read-only tasks", "multiple nonoverlapping tasks"],
	[
		"Workflow sub-Agents may investigate only; they must not modify files or create lower-level Agents. The Main Agent performs all modifications personally after workflow returns.",
		"In read-write mode each Workflow sub-agent may edit files and run commands only inside its own Git worktree and never starts lower-level Agents; its result reports the worktree path, branch and changed files. The Main Agent reviews those changes and performs any commit.",
	],
	[
		"All sub-Agents may only investigate, read, search, and run verification commands that do not modify the project. They must not modify files or create lower-level Agents. The Main Agent performs all modifications, then must call Ultracode again for independent verification and run necessary type checks, tests, or builds.",
		"In read-write mode each sub-agent may edit files and run commands only inside its own Git worktree and never starts lower-level Agents; its result reports the worktree path, branch and changed files. The Main Agent reviews those changes, performs any commit, and must call Ultracode again for independent verification and run necessary type checks, tests, or builds.",
	],
];

function withCapabilityWording(text: string, mode: SubAgentMode): string {
	if (mode !== "read-write") return text;
	return READ_WRITE_CAPABILITY_WORDING.reduce((current, [from, to]) => current.replace(from, to), text);
}

function normalizeSubAgentMode(mode: SubAgentMode | undefined): SubAgentMode {
	return mode === "read-write" ? "read-write" : "read-only";
}

/**
 * Schema is rebuilt on every createInvestigationToolDefinition call with the live
 * subAgent.maxTasks cap so a settings change (via rebuildDelegationDefinitions)
 * is immediately visible to the Main Agent; the static workflowSchema/ultracodeSchema
 * objects below remain only for type-level Static<> exports.
 */
function investigationSchemaFor<K extends InvestigationToolKind>(
	kind: K,
	mode: SubAgentMode,
	maxTasks: number,
): InvestigationSchema<K> {
	return createInvestigationSchema(
		INVESTIGATION_TOOL_PROFILES[kind].minPhases,
		mode,
		maxTasks,
	) as InvestigationSchema<K>;
}

export function createInvestigationToolDefinition<K extends InvestigationToolKind>(
	cwd: string,
	kind: K,
	options?: WorkflowToolOptions,
): BusinessToolDefinition<InvestigationSchema<K>, WorkflowToolDetails> {
	const profile = INVESTIGATION_TOOL_PROFILES[kind];
	const settingsAtBuild = options?.getSettings?.();
	const modeAtBuild = normalizeSubAgentMode(settingsAtBuild?.mode);
	const maxTasksAtBuild = resolveExploreMaxTasks(settingsAtBuild);
	const parameters = investigationSchemaFor(kind, modeAtBuild, maxTasksAtBuild);
	// Read-only profiles keep their historical wording verbatim; only the
	// capability clauses change when the Sub Agent mode is read-write.
	const description = withCapabilityWording(profile.description, modeAtBuild);
	return {
		name: kind,
		label: profile.label,
		description,
		promptSnippet: withCapabilityWording(profile.promptSnippet, modeAtBuild),
		promptGuidelines: profile.promptGuidelines.map((line) => withCapabilityWording(line, modeAtBuild)),
		parameters,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate) {
			if (params.phases.length < profile.minPhases) {
				const minimum = profile.minPhases === 1 ? "1" : `至少 ${profile.minPhases}`;
				throw new Error(`${profile.label} 需要 ${minimum} 个阶段。`);
			}
			for (const phase of params.phases) {
				if (phase.tasks.length < 1) {
					throw new Error(`${profile.label} 的每个阶段至少需要 1 个任务。`);
				}
			}

			const settings = options?.getSettings?.() ?? { enabled: false };
			const liveMaxTasks = resolveExploreMaxTasks(settings);
			const parentTraceScope = options?.getTraceParentScope?.();
			const workflowRunId = options?.trace?.createId("workflow");
			const details: WorkflowToolDetails = {
				name: params.name,
				workflowRunId,
				model: settings.model,
				status: "running",
				activePhase: 0,
				phases: params.phases.map((phase) => ({
					name: phase.name,
					status: "pending",
					completed: 0,
					total: phase.tasks.length,
					results: [],
				})),
			};
			const overLimitPhase = params.phases.find((phase) => phase.tasks.length > liveMaxTasks);
			if (overLimitPhase) {
				const received = overLimitPhase.tasks.length;
				details.status = "failed";
				return {
					content: [
						{
							type: "text" as const,
							text: `当前单阶段最多派发 ${liveMaxTasks} 个子智能体，阶段‘${overLimitPhase.name}’本次收到 ${received} 个，已拦截未执行。请保留全部 ${received} 个方向，不合并、不丢弃，将超出部分精简或拆分为后续阶段顺序推进，每阶段至多 ${liveMaxTasks} 个，全程单阶段活动子任务数不超过 ${liveMaxTasks}。`,
						},
					],
					details: cloneDetails(details),
				};
			}
			const failPreflight = (message: string): never => {
				details.status = "failed";
				const failure = new Error(message) as Error & { details?: WorkflowToolDetails };
				failure.details = cloneDetails(details);
				throw failure;
			};
			if (!settings.enabled) failPreflight(`${profile.label} 依赖 Sub Agent，请先在 /settings 中开启 Sub Agent。`);
			const provider = settings.provider;
			const model = settings.model;
			const thinkingLevel = settings.thinkingLevel;
			if (!provider || !model || !thinkingLevel) {
				failPreflight("Sub Agent 模型或思考强度配置不完整，请在 /settings 中重新设置。");
			}
			const runtimeSettings: ResolvedSubAgentRuntimeSettings = resolveSubAgentRuntimeSettings({
				...settings,
				provider: provider!,
				model: model!,
				thinkingLevel: thinkingLevel!,
			});
			const runBatch = options?.runBatch ?? runExploreBatch;
			const recordTrace = async (
				scope: RuntimeTraceScope | undefined,
				type: Parameters<RuntimeTrace["record"]>[1],
				data?: Record<string, unknown>,
			) => {
				if (options?.trace && scope) await options.trace.record(scope, type, data);
			};
			const handle = options?.dispatch?.begin({ source: kind, toolCallId, name: params.name });
			if (handle) details.batchId = handle.id;
			// The run's own lifetime: the session's controls when registered, else the tool call (as before).
			const runSignal = handle ? handle.signal : signal;
			// After a detach the tool call is over: progress goes to the session only.
			let toolLive = true;
			if (options?.trace && parentTraceScope) {
				await recordTrace(parentTraceScope, "workflow-started", {
					workflowRunId,
					kind,
					name: params.name,
					phaseCount: params.phases.length,
				});
			}
			const emitProgress = () => {
				handle?.progress(cloneDetails(details));
				if (!toolLive) return;
				onUpdate?.({
					content: [{ type: "text", text: formatProgress(details, profile.label) }],
					details: cloneDetails(details),
				});
			};

			const compactOutputs: Array<{ name: string; text: string }> = [];
			const fullOutputs: Array<{ name: string; text: string; filePath: string }> = [];
			let resultsDir: string | undefined;
			let activePhaseTraceScope: RuntimeTraceScope | undefined;
			let activePhaseTimedOut = false;
			let workflowTimedOut = false;
			let workflowDeadlineTimer: NodeJS.Timeout | undefined;
			const workflowController = new AbortController();
			const workflowCancellation = new Promise<never>((_, reject) => {
				workflowController.signal.addEventListener(
					"abort",
					() => {
						if (!workflowTimedOut) reject(new Error(`${profile.label} 已中止。`));
					},
					{ once: true },
				);
			});
			// The runtime control can be triggered before the first Promise.race is attached
			// (for example while the results directory is being created).
			void workflowCancellation.catch(() => undefined);
			let removeParentAbortListener: (() => void) | undefined;
			const parentCancellation = runSignal
				? new Promise<never>((_, reject) => {
						const onAbort = () =>
							reject(
								runSignal.reason instanceof Error ? runSignal.reason : new Error(`${profile.label} 已中止。`),
							);
						if (runSignal.aborted) {
							onAbort();
							return;
						}
						runSignal.addEventListener("abort", onAbort, { once: true });
						removeParentAbortListener = () => runSignal.removeEventListener("abort", onAbort);
					})
				: undefined;
			void parentCancellation?.catch(() => undefined);
			// Kill handles per phase (only the active phase has a live batch).
			const phaseKill: Array<((taskIndex: number) => void) | undefined> = [];
			options?.onControlsReady?.(toolCallId, {
				killTask: (phaseIndex, taskIndex) => phaseKill[phaseIndex]?.(taskIndex),
				killWorkflow: () => workflowController.abort(),
			});
			handle?.setControls({
				killTask: (ref) => phaseKill[ref.phase ?? details.activePhase]?.(ref.task),
				killAll: () => workflowController.abort(),
			});
			const run = async () => {
				try {
					if (runSignal?.aborted) throw new Error(`${profile.label} 已中止。`);
					const taskTimeoutMs = runtimeSettings.taskTimeoutMs ?? DEFAULT_SUB_AGENT_TASK_TIMEOUT_MS;
					const deadlineGraceMs = Math.max(0, options?.deadlineGraceMs ?? WORKFLOW_DEADLINE_GRACE_MS);
					const phaseTimeoutMs = taskTimeoutMs > 0 ? taskTimeoutMs + deadlineGraceMs : undefined;
					const workflowTimeoutMs =
						phaseTimeoutMs === undefined
							? undefined
							: Math.min(2_147_000_000, phaseTimeoutMs * params.phases.length + deadlineGraceMs);
					let workflowDeadline: Promise<never> | undefined;
					if (workflowTimeoutMs !== undefined) {
						workflowDeadline = new Promise<never>((_, reject) => {
							workflowDeadlineTimer = setTimeout(() => {
								workflowTimedOut = true;
								workflowController.abort();
								reject(new WorkflowTimeoutError("workflow"));
							}, workflowTimeoutMs);
						});
					}
					resultsDir = await mkdtemp(join(tmpdir(), "myharness-workflow-"));
					for (let index = 0; index < params.phases.length; index++) {
						if (runSignal?.aborted) throw new Error(`${profile.label} 已中止。`);
						const phase = params.phases[index];
						const phaseDetails = details.phases[index];
						const phaseId = options?.trace?.createId("phase");
						phaseDetails.phaseId = phaseId;
						details.activePhase = index;
						phaseDetails.status = "running";
						const phaseTraceScope =
							parentTraceScope && phaseId ? { ...parentTraceScope, phaseId, workflowRunId } : parentTraceScope;
						activePhaseTraceScope = phaseTraceScope;
						if (phaseTraceScope) {
							await recordTrace(phaseTraceScope, "phase-started", {
								phaseId,
								workflowRunId,
								name: phase.name,
								index,
							});
						}
						emitProgress();

						const previousPhase = fullOutputs[index - 1];
						activePhaseTimedOut = false;
						const phaseController = new AbortController();
						let phaseDeadlineTimer: NodeJS.Timeout | undefined;
						let phaseDeadline: Promise<never> | undefined;
						if (phaseTimeoutMs !== undefined) {
							phaseDeadline = new Promise<never>((_, reject) => {
								phaseDeadlineTimer = setTimeout(() => {
									activePhaseTimedOut = true;
									phaseController.abort();
									reject(new WorkflowTimeoutError("phase"));
								}, phaseTimeoutMs);
							});
						}
						const phaseSignal = AbortSignal.any([
							phaseController.signal,
							workflowController.signal,
							...(runSignal ? [runSignal] : []),
						]);
						let result: ExploreBatchResult;
						let phaseActive = true;
						const batchPromise = Promise.resolve().then(() =>
							runBatch({
								cwd,
								settings: runtimeSettings,
								signal: phaseSignal,
								trace: options?.trace,
								parentTraceScope: phaseTraceScope,
								phaseId,
								workflowRunId,
								tasks: phase.tasks.map((task) => ({
									description: task.description,
									prompt: appendPreviousPhaseContext(task.prompt, previousPhase),
									goal: task.goal,
									scope: task.scope,
									questions: task.questions,
									expectedOutput: task.expectedOutput,
									stopConditions: task.stopConditions,
								})),
								onProgress: (progress) => {
									if (!phaseActive) return;
									phaseDetails.completed = progress.completed;
									phaseDetails.usable = progress.usable;
									phaseDetails.findings = progress.findings;
									phaseDetails.results = progress.results.map(cloneResult);
									emitProgress();
								},
								onKillReady: (killTask) => {
									if (phaseActive) phaseKill[index] = killTask;
								},
							}),
						);
						try {
							result = await Promise.race([
								batchPromise,
								...(phaseDeadline ? [phaseDeadline] : []),
								...(workflowDeadline ? [workflowDeadline] : []),
								workflowCancellation,
								...(parentCancellation ? [parentCancellation] : []),
							]);
						} finally {
							phaseActive = false;
							phaseKill[index] = undefined;
							let drainTimer: NodeJS.Timeout | undefined;
							await Promise.race([
								batchPromise.then(
									() => undefined,
									() => undefined,
								),
								new Promise<void>((resolve) => {
									drainTimer = setTimeout(resolve, WORKFLOW_BATCH_DRAIN_TIMEOUT_MS);
								}),
							]);
							if (drainTimer) clearTimeout(drainTimer);
							if (phaseDeadlineTimer) clearTimeout(phaseDeadlineTimer);
						}
						if (activePhaseTimedOut || workflowTimedOut) {
							throw new WorkflowTimeoutError(workflowTimedOut ? "workflow" : "phase");
						}

						phaseDetails.results = result.details.results.map(cloneResult);
						const successfulTasks = phaseDetails.results.filter((task) => task.status === "completed").length;
						const usableTasks = phaseDetails.results.filter((task) =>
							isUsableTaskResult(task, normalizeSubAgentMode(runtimeSettings.mode)),
						).length;
						phaseDetails.completed = successfulTasks;
						phaseDetails.usable = usableTasks;
						phaseDetails.findings = phaseDetails.results.reduce(
							(count, task) => count + (task.findings?.length ?? 0),
							0,
						);
						const allTasksSucceeded =
							phaseDetails.results.length === phase.tasks.length && successfulTasks === phase.tasks.length;
						const phaseHasUsableResult = phaseDetails.results.length === phase.tasks.length && usableTasks > 0;
						phaseDetails.status = allTasksSucceeded
							? "completed"
							: phaseHasUsableResult
								? "partial"
								: phaseFailureStatus(phaseDetails.results);
						if (phaseTraceScope) {
							await recordTrace(phaseTraceScope, "phase-finished", {
								phaseId,
								workflowRunId,
								status: phaseDetails.status,
								completed: successfulTasks,
								usable: usableTasks,
								total: phase.tasks.length,
							});
						}
						activePhaseTraceScope = undefined;
						emitProgress();

						if (phaseDetails.status !== "completed" && phaseDetails.status !== "partial") {
							// Carry each failed task's own reason (including the worker's startup stderr) into the
							// message: without it the caller only sees a count and has to reproduce the failure to
							// learn the cause, while the plain Explore tool already shows the same details.
							const clip = (text: string, limit = 400) =>
								text.length <= limit ? text : `${text.slice(0, limit)}…`;
							const reasons = phaseDetails.results
								.filter((task) => task.status !== "completed" && task.status !== "partial")
								.map((task) => {
									const detail = [task.stopReason, task.error ?? task.lastToolInfo]
										.filter(Boolean)
										.map(String)
										.join(": ");
									return `${task.description || "task"}(${task.status}): ${clip(detail) || "unknown"}`;
								});
							throw new Error(
								`${profile.label} 阶段“${phase.name}”没有可用调查结果（${usableTasks}/${phase.tasks.length}）` +
									(reasons.length > 0 ? `。失败任务：${reasons.join("；")}` : "") +
									"，已停止后续阶段。",
							);
						}

						compactOutputs.push({ name: phase.name, text: result.text });
						// 结构化、有界结果落盘；完整文本仍由 Sub Agent 工具的 sidecar 保留，避免阶段间复制超长上下文
						// 上下文内联进每个任务的 prompt 导致 LLM 上下文溢出。
						const phaseResultsFile = join(resultsDir, `phase-${index}.md`);
						await writeFile(phaseResultsFile, result.text, { encoding: "utf8", mode: 0o600 });
						fullOutputs.push({ name: phase.name, text: result.fullText, filePath: phaseResultsFile });
					}

					details.status = details.phases.some((phase) => phase.status === "partial") ? "partial" : "completed";
					if (options?.trace && parentTraceScope) {
						await recordTrace(parentTraceScope, "workflow-finished", {
							workflowRunId,
							status: details.status,
							phaseCount: details.phases.length,
						});
					}
					const text = formatFinalOutput(profile.label, params.name, compactOutputs, details.status);
					const fullText = formatFinalOutput(profile.label, params.name, fullOutputs, details.status);
					const result = {
						content: [{ type: "text" as const, text }],
						details: cloneDetails(details),
					};
					if (fullText !== text) Object.assign(result, { [FULL_TEXT_OUTPUT]: fullText });
					return result;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const parentCancelled = runSignal?.aborted === true || workflowController.signal.aborted;
					const activePhase = details.phases[details.activePhase];
					const existingTerminalStatus =
						activePhase?.status === "timeout" ||
						activePhase?.status === "cancelled" ||
						activePhase?.status === "failed"
							? activePhase.status
							: undefined;
					const timedOut =
						activePhaseTimedOut || workflowTimedOut || (error as { code?: unknown })?.code === "WORKFLOW_TIMEOUT";
					const terminalStatus = timedOut
						? "timeout"
						: parentCancelled
							? "cancelled"
							: (existingTerminalStatus ?? "failed");
					details.status = terminalStatus;
					if (activePhase && activePhase.status !== "completed") {
						activePhase.status = terminalStatus;
						finalizeUnsettledPhaseTasks(
							activePhase,
							params.phases[details.activePhase].tasks,
							terminalStatus,
							message,
							details.model,
							normalizeSubAgentMode(runtimeSettings.mode),
						);
						if (activePhaseTraceScope) {
							await recordTrace(activePhaseTraceScope, "phase-finished", {
								phaseId: activePhase.phaseId,
								workflowRunId,
								status: terminalStatus,
								completed: activePhase.completed,
								total: activePhase.total,
							}).catch(() => {});
						}
					}
					if (options?.trace && parentTraceScope) {
						await recordTrace(parentTraceScope, "workflow-finished", {
							workflowRunId,
							status: terminalStatus,
							error: message,
						}).catch(() => {});
					}
					const failure = (
						timedOut || terminalStatus === "cancelled"
							? new Error(message)
							: error instanceof Error
								? error
								: new Error(message)
					) as Error & {
						code?: string;
						details?: WorkflowToolDetails;
					};
					if (terminalStatus === "timeout") failure.code = "WORKFLOW_TIMEOUT";
					if (terminalStatus === "cancelled") failure.code = "WORKFLOW_CANCELLED";
					failure.details = cloneDetails(details);
					emitProgress();
					throw failure;
				} finally {
					if (workflowDeadlineTimer) clearTimeout(workflowDeadlineTimer);
					removeParentAbortListener?.();
					if (resultsDir) {
						await rm(resultsDir, { recursive: true, force: true }).catch(() => {});
					}
					options?.onControlsRelease?.(toolCallId);
				}
			};
			const work = run();
			if (!handle) return await work;
			let outcome: Awaited<ReturnType<typeof awaitForegroundDispatch<Awaited<typeof work>>>>;
			try {
				outcome = await awaitForegroundDispatch(handle, work, signal);
			} catch (error) {
				const failedDetails = (error as { details?: WorkflowToolDetails })?.details;
				handle.finishForeground(failedDetails);
				const note = handle.stopNote();
				// Stopped from the panel while the main run goes on: tell the model it was the user's choice, not a failure to retry.
				if (note && failedDetails && !signal?.aborted) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text" as const, text: `${note}\n\n${message}` }], details: failedDetails };
				}
				throw error;
			}
			if (outcome.kind === "detached") {
				toolLive = false;
				handle.completeInBackground(
					work.then((result) => ({
						status: result.details.status === "partial" ? ("partial" as const) : ("completed" as const),
						text: result.content[0]?.text ?? "",
						fullText: (result as { [FULL_TEXT_OUTPUT]?: string })[FULL_TEXT_OUTPUT],
						details: { ...result.details, background: true },
					})),
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `主智能体被用户的新消息打断；${profile.label}“${params.name}”（${handle.id}）没有被取消，已转入后台继续运行，完成后结果会自动交回主 Agent。不要重复启动同一个${profile.label}。`,
						},
					],
					details: { ...cloneDetails(details), background: true },
				};
			}
			const result = outcome.value;
			handle.finishForeground(result.details);
			const note = handle.stopNote();
			if (note) result.content = [{ type: "text" as const, text: `${note}\n\n${result.content[0]?.text ?? ""}` }];
			return result;
		},
	};
}

export function createWorkflowToolDefinition(
	cwd: string,
	options?: WorkflowToolOptions,
): BusinessToolDefinition<typeof workflowSchema, WorkflowToolDetails> {
	return createInvestigationToolDefinition(cwd, "workflow", options);
}

export function createWorkflowTool(cwd: string, options?: WorkflowToolOptions) {
	return wrapToolDefinition(createWorkflowToolDefinition(cwd, options));
}

export function createUltracodeToolDefinition(
	cwd: string,
	options?: UltracodeToolOptions,
): BusinessToolDefinition<typeof ultracodeSchema, UltracodeToolDetails> {
	return createInvestigationToolDefinition(cwd, "ultracode", options);
}

export function createUltracodeTool(cwd: string, options?: UltracodeToolOptions) {
	return wrapToolDefinition(createUltracodeToolDefinition(cwd, options));
}
