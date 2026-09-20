import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { redactSensitiveText } from "./diagnostic-sanitizer.ts";

/** The execution role recorded in an internal runtime trace. */
/** The execution role of a MyHarness session. */
export type RuntimeTraceRole = "main" | "delegated";

/** Normalized terminal states used by trace events. */
export type RuntimeTraceStatus = "running" | "completed" | "partial" | "failed" | "cancelled" | "timeout" | "retrying";

export type RuntimeTraceEventType =
	| "run-started"
	| "agent-started"
	| "agent-finished"
	| "turn-started"
	| "turn-finished"
	| "phase-started"
	| "phase-finished"
	| "workflow-started"
	| "workflow-finished"
	| "task-started"
	| "task-progress"
	| "task-finished"
	| "tool-started"
	| "tool-finished"
	| "model-request"
	| "model-response"
	| "provider-response"
	| "retry"
	| "review-round-started"
	| "review-round-finished"
	| "run-finished"
	| "trace-error";

export interface RuntimeTraceScope {
	runId: string;
	sessionId: string;
	parentRunId?: string;
	agentId: string;
	role: RuntimeTraceRole;
	phaseId?: string;
	taskId?: string;
	workflowRunId?: string;
}

export interface RuntimeTraceChildContext extends RuntimeTraceScope {
	traceDir: string;
}

export interface RuntimeTraceEvent {
	schemaVersion: 1;
	seq: number;
	type: RuntimeTraceEventType;
	at: string;
	runId: string;
	sessionId: string;
	parentRunId?: string;
	agentId: string;
	role: RuntimeTraceRole;
	phaseId?: string;
	taskId?: string;
	workflowRunId?: string;
	data?: Record<string, unknown>;
}

export interface RuntimeTraceOptions {
	/** Usually `~/.myharness/agent/traces`; tests may inject a temporary directory. */
	traceDir?: string;
	sessionId: string;
	parentRunId?: string;
	runId?: string;
	agentId?: string;
	role?: RuntimeTraceRole;
	phaseId?: string;
	taskId?: string;
	workflowRunId?: string;
	cwd?: string;
}

interface TraceFileState {
	filePath: string;
	sequence: number;
	queue: Promise<void>;
	writeError?: Error;
}

const SENSITIVE_KEY_PATTERN =
	/(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|cookie|credential|password|passphrase|private[_-]?key|secret|system[_-]?prompt|prompt|environment|env|headers?)/i;
const MAX_STRING_LENGTH = 512;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_KEYS = 48;

function safeSegment(value: unknown): string {
	const segment = String(value ?? "unknown")
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 160);
	return segment || "unknown";
}

function nowIso(): string {
	return new Date().toISOString();
}

function createId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

function hashValue(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key, item: unknown) => {
				if (typeof item === "object" && item !== null) {
					if (seen.has(item)) return "[Circular]";
					seen.add(item);
				}
				return item;
			}) ?? String(value)
		);
	} catch {
		return String(value);
	}
}

function redactString(value: string): string {
	const result = redactSensitiveText(value);
	return result.length > MAX_STRING_LENGTH ? `${result.slice(0, MAX_STRING_LENGTH)}…` : result;
}

function sanitizeValue(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
	if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
	if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return redactString(value);
	if (depth >= 5) return "[TRUNCATED]";
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, key, depth + 1, seen));
	}
	const result: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
		result[childKey] = sanitizeValue(childValue, childKey, depth + 1, seen);
	}
	return result;
}

function summarizePath(value: unknown, cwd: string | undefined): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const input = value.trim();
	if (!cwd) return input.length > MAX_STRING_LENGTH ? `${input.slice(0, MAX_STRING_LENGTH)}…` : input;
	try {
		const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
		const relativePath = relative(resolve(cwd), absolute);
		if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
			return relativePath || ".";
		}
		return `[outside-workspace] ${basename(absolute)}`;
	} catch {
		return "[invalid-path]";
	}
}

function commandCategory(command: unknown): string | undefined {
	if (typeof command !== "string" || command.trim() === "") return undefined;
	const normalized = command.trim().replace(/\\/g, "/");
	const firstWords = normalized
		.split(/\s+/)
		.slice(0, 3)
		.map(
			(word) =>
				word
					.replace(/^['"]|['"]$/g, "")
					.split("/")
					.pop() ?? word,
		)
		.join(" ");
	return redactString(firstWords).slice(0, 120);
}

export function summarizeToolArguments(toolName: string, args: unknown, cwd?: string): Record<string, unknown> {
	const objectArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
	const summary: Record<string, unknown> = {
		keys: objectArgs ? Object.keys(objectArgs).slice(0, MAX_OBJECT_KEYS) : [],
		argHash: hashValue(sanitizeValue(args)),
	};
	if (objectArgs) {
		const pathValue = objectArgs.path ?? objectArgs.file_path ?? objectArgs.filePath;
		const pathSummary = summarizePath(pathValue, cwd);
		if (pathSummary) summary.path = pathSummary;
		if (toolName.toLowerCase() === "bash") {
			summary.commandCategory = commandCategory(objectArgs.command);
			if (typeof objectArgs.command === "string") summary.commandLength = objectArgs.command.length;
		}
	}
	return summary;
}

export function summarizeToolResult(result: unknown, isError = false): Record<string, unknown> {
	const objectResult = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
	const content = objectResult?.content;
	const contentItems = Array.isArray(content) ? content : content === undefined ? [] : [content];
	const textLength = contentItems.reduce((total, item) => {
		if (typeof item === "string") return total + item.length;
		if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
			return total + String((item as Record<string, unknown>).text).length;
		}
		return total;
	}, 0);
	const summary: Record<string, unknown> = {
		isError,
		contentItems: contentItems.length,
		textLength,
		resultHash: hashValue(sanitizeValue(result)),
	};
	for (const key of ["exitCode", "cancelled", "canceled", "timedOut", "timeout", "truncated", "terminate"]) {
		if (objectResult && key in objectResult) summary[key] = sanitizeValue(objectResult[key], key);
	}
	const errorMessage = objectResult?.errorMessage ?? objectResult?.error;
	if (typeof errorMessage === "string") summary.error = redactString(errorMessage);
	return summary;
}

export function classifyToolStatus(result: unknown, isError: boolean): RuntimeTraceStatus {
	if (!isError) return "completed";
	const objectResult = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
	if (objectResult?.timedOut === true || objectResult?.timeout === true) return "timeout";
	if (objectResult?.cancelled === true || objectResult?.canceled === true) return "cancelled";
	return "failed";
}

function defaultTraceDir(): string {
	return join(homedir(), ".myharness", "agent", "traces");
}

function isTraceEvent(value: unknown): value is RuntimeTraceEvent {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as RuntimeTraceEvent).schemaVersion === 1 &&
			typeof (value as RuntimeTraceEvent).seq === "number" &&
			typeof (value as RuntimeTraceEvent).type === "string" &&
			typeof (value as RuntimeTraceEvent).at === "string" &&
			typeof (value as RuntimeTraceEvent).runId === "string",
	);
}

/**
 * Append-only, redacted runtime trace writer.
 *
 * Each run gets its own JSONL file. Writes are serialized per run so concurrent
 * tool events retain the order in which the writer accepted them. A write
 * failure is remembered and causes later writes to fail; callers can use
 * `hasWriteError()` before reporting a run as successful.
 */
export class RuntimeTrace {
	readonly traceDir: string;
	readonly sessionId: string;
	private readonly cwd?: string;
	private readonly defaultContext: Omit<RuntimeTraceScope, "runId">;
	private readonly files = new Map<string, TraceFileState>();

	constructor(options: RuntimeTraceOptions) {
		this.traceDir = resolve(options.traceDir ?? defaultTraceDir());
		this.sessionId = safeSegment(options.sessionId);
		this.cwd = options.cwd;
		this.defaultContext = {
			sessionId: this.sessionId,
			parentRunId: options.parentRunId,
			agentId: options.agentId ?? createId("agent"),
			role: options.role ?? "main",
			phaseId: options.phaseId,
			taskId: options.taskId,
			workflowRunId: options.workflowRunId,
		};
		if (options.runId) {
			this.ensureScope({ ...this.defaultContext, runId: options.runId });
		}
	}

	createId(prefix: string): string {
		return createId(prefix);
	}

	createScope(overrides: Partial<RuntimeTraceScope> = {}): RuntimeTraceScope {
		return {
			...this.defaultContext,
			...overrides,
			runId: overrides.runId ?? createId("run"),
		};
	}

	createChildContext(parent: RuntimeTraceScope, overrides: Partial<RuntimeTraceScope> = {}): RuntimeTraceChildContext {
		return {
			...this.createScope({
				...parent,
				runId: createId("run"),
				parentRunId: parent.runId,
				...overrides,
			}),
			traceDir: this.traceDir,
		};
	}

	getFilePath(runId: string): string {
		return join(this.traceDir, safeSegment(this.sessionId), `${safeSegment(runId)}.jsonl`);
	}

	hasWriteError(runId?: string): boolean {
		if (runId) return this.files.get(runId)?.writeError !== undefined;
		return [...this.files.values()].some((state) => state.writeError !== undefined);
	}

	getWriteError(runId?: string): Error | undefined {
		if (runId) return this.files.get(runId)?.writeError;
		return [...this.files.values()].find((state) => state.writeError)?.writeError;
	}

	async record(scope: RuntimeTraceScope, type: RuntimeTraceEventType, data?: Record<string, unknown>): Promise<void> {
		const state = this.ensureScope(scope);
		if (state.writeError) throw state.writeError;
		const event: RuntimeTraceEvent = {
			schemaVersion: 1,
			seq: ++state.sequence,
			type,
			at: nowIso(),
			runId: scope.runId,
			sessionId: safeSegment(scope.sessionId),
			...(scope.parentRunId ? { parentRunId: scope.parentRunId } : {}),
			agentId: scope.agentId,
			role: scope.role,
			...(scope.phaseId ? { phaseId: scope.phaseId } : {}),
			...(scope.taskId ? { taskId: scope.taskId } : {}),
			...(scope.workflowRunId ? { workflowRunId: scope.workflowRunId } : {}),
			...(data ? { data: sanitizeValue(data) as Record<string, unknown> } : {}),
		};
		const line = `${JSON.stringify(event)}\n`;
		state.queue = state.queue.then(async () => {
			await mkdir(dirname(state.filePath), { recursive: true });
			await appendFile(state.filePath, line, { encoding: "utf8", mode: 0o600 });
		});
		try {
			await state.queue;
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			state.writeError = normalized;
			throw normalized;
		}
	}

	async recordToolStarted(
		scope: RuntimeTraceScope,
		toolCallId: string,
		toolName: string,
		args: unknown,
	): Promise<void> {
		await this.record(scope, "tool-started", {
			toolCallId,
			toolName,
			args: summarizeToolArguments(toolName, args, this.cwd),
		});
	}

	async recordToolFinished(
		scope: RuntimeTraceScope,
		toolCallId: string,
		toolName: string,
		status: RuntimeTraceStatus,
		durationMs: number,
		result: unknown,
		isError: boolean,
		extra: Record<string, unknown> = {},
	): Promise<void> {
		await this.record(scope, "tool-finished", {
			toolCallId,
			toolName,
			status,
			durationMs: Math.max(0, Math.round(durationMs)),
			result: summarizeToolResult(result, isError),
			...extra,
		});
	}

	async flush(runId?: string): Promise<void> {
		const states = runId ? [this.files.get(runId)].filter(Boolean) : [...this.files.values()];
		await Promise.all(states.map((state) => state?.queue));
		const error = this.getWriteError(runId);
		if (error) throw error;
	}

	private ensureScope(scope: RuntimeTraceScope): TraceFileState {
		let state = this.files.get(scope.runId);
		if (!state) {
			state = {
				filePath: this.getFilePath(scope.runId),
				sequence: 0,
				queue: Promise.resolve(),
			};
			this.files.set(scope.runId, state);
		}
		return state;
	}
}

export async function readRuntimeTrace(filePath: string): Promise<RuntimeTraceEvent[]> {
	const text = await readFile(filePath, "utf8");
	const events: RuntimeTraceEvent[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isTraceEvent(parsed)) break;
			events.push(parsed);
		} catch {
			// A process can die while writing a line. Keep only the valid prefix;
			// later lines are not trustworthy after a malformed JSONL record.
			break;
		}
	}
	return events;
}

export function getRuntimeTraceEnvironment(context: RuntimeTraceChildContext): Record<string, string> {
	return {
		MYHARNESS_TRACE_DIR: context.traceDir,
		MYHARNESS_TRACE_SESSION_ID: context.sessionId,
		MYHARNESS_TRACE_RUN_ID: context.runId,
		...(context.parentRunId ? { MYHARNESS_TRACE_PARENT_RUN_ID: context.parentRunId } : {}),
		MYHARNESS_TRACE_AGENT_ID: context.agentId,
		MYHARNESS_TRACE_ROLE: context.role,
		...(context.phaseId ? { MYHARNESS_TRACE_PHASE_ID: context.phaseId } : {}),
		...(context.taskId ? { MYHARNESS_TRACE_TASK_ID: context.taskId } : {}),
		...(context.workflowRunId ? { MYHARNESS_TRACE_WORKFLOW_RUN_ID: context.workflowRunId } : {}),
	};
}

export function getRuntimeTraceOptionsFromEnvironment(
	cwd: string,
	fallback: { traceDir?: string; sessionId: string },
): RuntimeTraceOptions {
	const role = process.env.MYHARNESS_TRACE_ROLE;
	const validRole: RuntimeTraceRole = role === "delegated" ? role : "main";
	return {
		traceDir: process.env.MYHARNESS_TRACE_DIR ?? fallback.traceDir,
		sessionId: process.env.MYHARNESS_TRACE_SESSION_ID ?? fallback.sessionId,
		parentRunId: process.env.MYHARNESS_TRACE_PARENT_RUN_ID,
		runId: process.env.MYHARNESS_TRACE_RUN_ID,
		agentId: process.env.MYHARNESS_TRACE_AGENT_ID,
		role: validRole,
		phaseId: process.env.MYHARNESS_TRACE_PHASE_ID,
		taskId: process.env.MYHARNESS_TRACE_TASK_ID,
		workflowRunId: process.env.MYHARNESS_TRACE_WORKFLOW_RUN_ID,
		cwd,
	};
}
