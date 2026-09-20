import { contentText, type Message } from "@myharness/ai";
import type { AgentMessage } from "../../types.ts";

/** File paths touched by a session branch or compaction range. */
export interface FileOperations {
	/** Files read but not necessarily modified. */
	read: Set<string>;
	/** Files written by full-file write operations. */
	written: Set<string>;
	/** Files modified by edit operations. */
	edited: Set<string>;
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/** Add file operations from assistant tool calls to an accumulator. */
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

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/** Format file lists as summary metadata tags. */
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

/** Bounded user-request text retained independently of model summarization. */
export interface CompactionUserAnchor {
	kind: "initial-request" | "recent-request";
	text: string;
}

export const MAX_COMPACTION_USER_ANCHORS = 2;

/** Merge a sticky initial request with the newest folded request. */
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
	let initial = previous?.find((anchor) => valid(anchor) && anchor.kind === "initial-request");
	let recent = previous?.find((anchor) => valid(anchor) && anchor.kind === "recent-request");
	for (const anchor of next ?? []) {
		if (!valid(anchor)) continue;
		if (anchor.kind === "initial-request") initial ??= anchor;
		else recent = anchor;
	}
	if (initial && recent && initial.text === recent.text) return [initial];
	return [initial, recent]
		.filter((anchor): anchor is CompactionUserAnchor => anchor !== undefined)
		.slice(0, MAX_COMPACTION_USER_ANCHORS);
}

/** Render deterministic continuity metadata into the active compaction message. */
export function renderCompactionUserAnchors(userAnchors: CompactionUserAnchor[] | undefined): string {
	if (!userAnchors || userAnchors.length === 0) return "";
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
	return lines.length > 2 ? lines.join("\n") : "";
}

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
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
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
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
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}
