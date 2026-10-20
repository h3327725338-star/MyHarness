import type { FileEntry, SessionEntry, SessionHeader } from "../types.ts";

/**
 * One searchable message of a saved conversation: a user message or the visible text of an assistant reply.
 * Tool output, reasoning and attachments are deliberately not part of it (see docs/session-format.md, "History index").
 */
export interface HistoryRecord {
	/** Entry id in the session JSONL; stable across reloads. */
	id: string;
	parentId: string | null;
	role: "user" | "assistant";
	/** Epoch millis of the entry. */
	ts: number;
	text: string;
	/** On the path from the file's leaf (its last entry) to the root, i.e. the branch a reload continues. */
	onBranch: boolean;
	/** Assistant replies that did not finish normally keep that fact, so a search never presents them as complete. */
	stopReason?: "aborted" | "error" | "length";
}

export interface HistoryRecordSet {
	sessionId: string;
	title?: string;
	cwd: string;
	mode: "coding" | "general";
	/** Leaf the records were projected for (the file's last entry). */
	leafId: string | null;
	records: HistoryRecord[];
}

/** Text parts only: reasoning, tool calls and images are not conversation text. */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

/** Ids on the path from `leafId` to the root. Cycles (corrupt files) stop the walk instead of looping. */
export function branchIds(entries: readonly SessionEntry[], leafId: string | null): Set<string> {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const ids = new Set<string>();
	let current = leafId ? byId.get(leafId) : undefined;
	while (current && !ids.has(current.id)) {
		ids.add(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return ids;
}

/** Project a parsed JSONL file into its searchable messages. The header must be the first entry. */
export function buildHistoryRecords(fileEntries: readonly FileEntry[]): HistoryRecordSet | undefined {
	const header = fileEntries[0];
	if (!header || header.type !== "session") return undefined;
	const sessionHeader = header as SessionHeader;
	const entries = fileEntries.slice(1) as SessionEntry[];
	const leafId = entries.at(-1)?.id ?? null;
	const onBranch = branchIds(entries, leafId);
	let title: string | undefined;
	const records: HistoryRecord[] = [];
	for (const entry of entries) {
		if (entry.type === "session_info") title = entry.name?.trim() || undefined;
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown; stopReason?: string };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = messageText(message.content).trim();
		if (!text) continue;
		const ts = Date.parse(entry.timestamp);
		const stopReason =
			message.role === "assistant" &&
			(message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "length")
				? message.stopReason
				: undefined;
		records.push({
			id: entry.id,
			parentId: entry.parentId,
			role: message.role,
			ts: Number.isFinite(ts) ? ts : 0,
			text,
			onBranch: onBranch.has(entry.id),
			...(stopReason ? { stopReason } : {}),
		});
	}
	return {
		sessionId: sessionHeader.id,
		title,
		cwd: typeof sessionHeader.cwd === "string" ? sessionHeader.cwd : "",
		mode: sessionHeader.mode === "general" ? "general" : "coding",
		leafId,
		records,
	};
}
