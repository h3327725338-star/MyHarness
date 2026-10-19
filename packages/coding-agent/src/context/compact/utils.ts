/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@myharness/agent-core";
import { contentText, type Message } from "@myharness/ai";
import { getRenamePlanPaths } from "../../symbols/workflow/rename-plans.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { applyPatchPaths } from "../../tools/files/apply-patch-parser.ts";

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

		// apply_patch names its files inside the patch text, not in a path argument.
		if (block.name === "apply_patch") {
			for (const path of applyPatchPaths(args.patch)) fileOps.edited.add(path);
			continue;
		}
		// apply_rename names only its plan; the plan registry remembers the files it wrote.
		if (block.name === "apply_rename") {
			for (const path of getRenamePlanPaths(args.planId)) fileOps.edited.add(path);
			continue;
		}

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

const _EXECUTION_SCOPE_MAX_CHARS = 200;
const _EXECUTION_SCOPE_VALUE_MAX_CHARS = 120;
const _EXECUTION_EVIDENCE_HEAD_CHARS = 160;
const _EXECUTION_EVIDENCE_TAIL_CHARS = 80;

function _boundExecutionText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…[+${text.length - maxChars} chars]`;
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

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = loadSystemPrompt("compaction/coding-agent/system.md");
