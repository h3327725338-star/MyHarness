/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@myharness/agent-core";
import { contentText, type Message } from "@myharness/ai";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/**
 * Bounded tool-result representation for summarization.
 *
 * Long tool results are NOT reduced to a random prefix. The representation
 * keeps the tool name, execution status, call id, the head of the output and
 * the tail of the output (where final conclusions usually live), plus the
 * amount of content that was omitted. Short results stay verbatim.
 */
const TOOL_RESULT_HEAD_CHARS = 1200;
const TOOL_RESULT_TAIL_CHARS = 800;

/** Bounded serialization of one tool call's arguments (used in assistant tool-call lines). */
const TOOL_CALL_ARGS_MAX_CHARS = 2000;
const TOOL_CALL_ARG_VALUE_MAX_CHARS = 200;

/**
 * Serialize a tool result for summarization.
 *
 * - Short results: the full text, unchanged.
 * - Long results: tool metadata + head + omission marker + tail, so later
 *   findings are not lost just because they do not fit in a prefix.
 */
function serializeToolResult(message: Extract<Message, { role: "toolResult" }>): string {
	const content = contentText(message.content, "");
	if (content.length <= TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS) {
		return `[Tool result]: ${content}`;
	}
	const head = content.slice(0, TOOL_RESULT_HEAD_CHARS);
	const tail = content.slice(-TOOL_RESULT_TAIL_CHARS);
	const omitted = content.length - head.length - tail.length;
	const meta = [`Tool: ${message.toolName ?? "unknown"}`, `Status: ${message.isError ? "error" : "ok"}`];
	if (message.toolCallId) meta.push(`Call: ${message.toolCallId}`);
	return [`[Tool result]:`, ...meta, "", head, "", `[... ${omitted} characters omitted ...]`, "", tail].join("\n");
}

/** Bound one assistant tool-call argument list so huge invocation payloads stay readable. */
function serializeToolCallArgs(args: Record<string, unknown>): string {
	const entries = Object.entries(args);
	const parts: string[] = [];
	for (const [key, value] of entries) {
		let text: string;
		try {
			text = typeof value === "string" ? value : JSON.stringify(value);
		} catch {
			text = String(value);
		}
		if (text.length > TOOL_CALL_ARG_VALUE_MAX_CHARS) {
			text = `${text.slice(0, TOOL_CALL_ARG_VALUE_MAX_CHARS)}…[+${text.length - TOOL_CALL_ARG_VALUE_MAX_CHARS} chars]`;
		}
		parts.push(`${key}=${text}`);
	}
	const joined = parts.join(", ");
	return joined.length > TOOL_CALL_ARGS_MAX_CHARS
		? `${joined.slice(0, TOOL_CALL_ARGS_MAX_CHARS)}…[+${joined.length - TOOL_CALL_ARGS_MAX_CHARS} chars]`
		: joined;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = (block.arguments ?? {}) as Record<string, unknown>;
					toolCalls.push(`${block.name}(${serializeToolCallArgs(args)})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			parts.push(serializeToolResult(msg));
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Tool Execution Continuity
// ============================================================================

/**
 * Bounded structured record of one completed tool execution.
 *
 * This is runtime-captured (deterministic) metadata that survives compaction
 * independently of what the generative summary decides to mention. It answers
 * "has this investigation already been done, with which scope, and where is
 * the full result?" so the Main Agent does not re-run heavy tools merely
 * because it forgot they ran.
 */
export interface ToolExecutionRecord {
	tool: string;
	status: "completed" | "failed" | "aborted" | "unknown";
	/** Bounded invocation scope/arguments summary. */
	scope: string;
	/** Persisted full-result artifact path, when one exists. */
	artifactPath?: string;
	/** Bounded result evidence (head + tail of the tool output). */
	evidence?: string;
}

/**
 * Small, deterministic copies of the user's task text that survive a
 * compaction independently of the summarization model.  These are deliberately
 * bounded and are reference material, not a second live user turn.
 */
export interface CompactionUserAnchor {
	kind: "initial-request" | "recent-request";
	text: string;
}

/** Keep the deterministic task anchors small enough that they cannot crowd out
 * the generated handoff summary or the active tool tail. */
export const MAX_COMPACTION_USER_ANCHORS = 2;

/** Hard cap on records carried in one compaction entry (carry-forward + new). */
export const MAX_EXECUTION_RECORDS = 24;

const EXECUTION_SCOPE_MAX_CHARS = 200;
const EXECUTION_SCOPE_VALUE_MAX_CHARS = 120;
const EXECUTION_EVIDENCE_HEAD_CHARS = 160;
const EXECUTION_EVIDENCE_TAIL_CHARS = 80;
const EXECUTION_ARTIFACT_MAX_CHARS = 400;

function boundExecutionText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…[+${text.length - maxChars} chars]`;
}

/** Build the bounded invocation scope for a tool call. */
export function summarizeToolCallScope(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args !== "object") return boundExecutionText(String(args), EXECUTION_SCOPE_MAX_CHARS);
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		let text: string;
		try {
			text = typeof value === "string" ? value : JSON.stringify(value);
		} catch {
			text = String(value);
		}
		if (text.length > EXECUTION_SCOPE_VALUE_MAX_CHARS) {
			text = `${text.slice(0, EXECUTION_SCOPE_VALUE_MAX_CHARS)}…[+${text.length - EXECUTION_SCOPE_VALUE_MAX_CHARS} chars]`;
		}
		parts.push(`${key}=${text}`);
	}
	if (parts.length === 0) return "";
	return boundExecutionText(parts.join("; "), EXECUTION_SCOPE_MAX_CHARS);
}

/** Build bounded head+tail evidence from a tool result's text. */
export function summarizeToolResultEvidence(text: string): string {
	if (text.length <= EXECUTION_EVIDENCE_HEAD_CHARS + EXECUTION_EVIDENCE_TAIL_CHARS) return text;
	const head = text.slice(0, EXECUTION_EVIDENCE_HEAD_CHARS);
	const tail = text.slice(-EXECUTION_EVIDENCE_TAIL_CHARS);
	return `${head}\n…[${text.length - head.length - tail.length} chars omitted]…\n${tail}`;
}

/**
 * Extract tool execution facts from one message into a keyed record map.
 *
 * The map is keyed by tool call id so an assistant tool-call block and its
 * tool result update the same record. Records without a call id (or results
 * whose call id is missing) are tracked by an empty key.
 */
export function extractToolExecutionsFromMessage(
	message: AgentMessage,
	records: Map<string, ToolExecutionRecord>,
): void {
	if (message.role === "assistant" && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || block.type !== "toolCall") continue;
			if (!("name" in block) || typeof block.name !== "string") continue;
			const callId = "id" in block && typeof block.id === "string" ? block.id : "";
			const key = `call:${callId}`;
			const existing = records.get(key);
			records.set(key, {
				tool: block.name,
				status: existing?.status ?? "unknown",
				scope: existing?.scope ?? summarizeToolCallScope(block.arguments),
				artifactPath: existing?.artifactPath,
				evidence: existing?.evidence,
			});
		}
	} else if (message.role === "toolResult") {
		const result = message as Extract<AgentMessage, { role: "toolResult" }>;
		const callId = result.toolCallId ?? "";
		const key = `call:${callId}`;
		const existing = records.get(key);
		const content = contentText(result.content, "");
		const details = (result.details ?? {}) as Record<string, unknown>;
		const artifactPath = typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;
		records.set(key, {
			tool: existing?.tool ?? result.toolName ?? "unknown",
			status: result.isError === true ? "failed" : "completed",
			scope: existing?.scope ?? "",
			artifactPath:
				existing?.artifactPath ??
				(artifactPath ? boundExecutionText(artifactPath, EXECUTION_ARTIFACT_MAX_CHARS) : undefined),
			evidence: existing?.evidence ?? (content ? summarizeToolResultEvidence(content) : undefined),
		});
	}
}

/**
 * Merge carried-forward records with newly extracted records.
 *
 * - Carried records come first (older executions stay known).
 * - New records are appended; duplicates (same tool call id, or same
 *   tool + scope when no call id exists) are replaced by the newer record.
 * - The merged list is bounded to {@link MAX_EXECUTION_RECORDS}; when the cap
 *   is exceeded the oldest records are dropped, so the metadata never grows
 *   without bound across repeated compactions.
 */
export function mergeToolExecutions(
	previous: ToolExecutionRecord[] | undefined,
	next: ToolExecutionRecord[] | undefined,
): ToolExecutionRecord[] {
	const merged: ToolExecutionRecord[] = [];
	const seen = new Set<string>();
	const push = (record: ToolExecutionRecord): void => {
		const key = `${record.tool}\u0000${record.scope}`;
		if (seen.has(key)) return;
		seen.add(key);
		merged.push(record);
	};
	if (Array.isArray(previous)) {
		for (const record of previous) push(record);
	}
	if (Array.isArray(next)) {
		for (const record of next) push(record);
	}
	if (merged.length <= MAX_EXECUTION_RECORDS) return merged;
	return merged.slice(merged.length - MAX_EXECUTION_RECORDS);
}

/**
 * Merge user-task anchors across compaction generations.
 *
 * The initial request is sticky, while the recent request is replaced by the
 * newest one.  This prevents the first task/constraints from disappearing on a
 * later compaction without allowing a growing transcript of every user turn.
 */
export function mergeCompactionUserAnchors(
	previous: CompactionUserAnchor[] | undefined,
	next: CompactionUserAnchor[] | undefined,
): CompactionUserAnchor[] {
	const valid = (anchor: unknown): anchor is CompactionUserAnchor =>
		typeof anchor === "object" &&
		anchor !== null &&
		((anchor as CompactionUserAnchor).kind === "initial-request" ||
			(anchor as CompactionUserAnchor).kind === "recent-request") &&
		typeof (anchor as CompactionUserAnchor).text === "string" &&
		(anchor as CompactionUserAnchor).text.length > 0;
	let initial: CompactionUserAnchor | undefined = previous?.find(
		(anchor) => valid(anchor) && anchor.kind === "initial-request",
	);
	let recent: CompactionUserAnchor | undefined = previous?.find(
		(anchor) => valid(anchor) && anchor.kind === "recent-request",
	);

	for (const anchor of next ?? []) {
		if (!valid(anchor)) continue;
		if (anchor.kind === "initial-request") {
			initial ??= anchor;
		} else {
			recent = anchor;
		}
	}

	if (initial && recent && initial.text === recent.text) return [initial];
	return [initial, recent]
		.filter((anchor): anchor is CompactionUserAnchor => anchor !== undefined)
		.slice(0, MAX_COMPACTION_USER_ANCHORS);
}

/**
 * Render deterministic compaction metadata into the active summary message.
 * The generated summary remains the primary handoff; these sections preserve
 * facts that are cheap to retain and costly to rediscover.
 */
export function renderCompactionContinuity(
	userAnchors: CompactionUserAnchor[] | undefined,
	executions: ToolExecutionRecord[] | undefined,
): string {
	const sections: string[] = [];
	if (userAnchors && userAnchors.length > 0) {
		const lines = ["", "User task anchors preserved by runtime (reference only; not a new request):"];
		for (const anchor of userAnchors) {
			if (
				(anchor.kind !== "initial-request" && anchor.kind !== "recent-request") ||
				typeof anchor.text !== "string" ||
				anchor.text.length === 0
			) {
				continue;
			}
			lines.push(`- ${anchor.kind}:`, anchor.text);
		}
		if (lines.length > 2) sections.push(lines.join("\n"));
	}
	if (executions && executions.length > 0) {
		const lines: string[] = [];
		lines.push("", "Execution continuity preserved by runtime:");
		for (const record of executions) {
			lines.push(`- ${record.tool} | ${record.status}`);
			if (record.scope) lines.push(`  scope: ${record.scope}`);
			if (record.artifactPath) lines.push(`  artifact: ${record.artifactPath}`);
			if (record.evidence) lines.push(`  result: ${record.evidence}`);
		}
		sections.push(lines.join("\n"));
	}
	return sections.join("\n");
}

/**
 * Deterministic, program-generated context section listing the tool
 * executions that must survive compaction. This is NOT produced by the
 * summary model; it is rendered from structured metadata so the fact "this
 * investigation already ran" cannot be accidentally dropped.
 */
export function renderExecutionContinuity(executions: ToolExecutionRecord[] | undefined): string {
	return renderCompactionContinuity(undefined, executions);
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = loadSystemPrompt("compaction/coding-agent/system.md");
