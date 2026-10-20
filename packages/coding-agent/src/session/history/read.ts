import { loadEntriesFromFile } from "../storage/jsonl/index.ts";
import type { SessionEntry } from "../types.ts";
import { type HandoffState, handoffStatus, readHandoff } from "./handoff-store.ts";
import { loadHistoryRecords } from "./index-store.ts";
import type { HistoryRecord } from "./records.ts";

/**
 * Read a saved conversation the way a person would scroll it: the hand-off note (with how far it reaches), and either
 * the messages around one entry (along that entry's own branch) or the newest messages of the current branch.
 */

export interface HistoryReadOptions {
	path: string;
	/** Read around this entry; without it the newest messages of the current branch are returned. */
	entryId?: string;
	before?: number;
	after?: number;
	/** Messages returned without an entry id. */
	tail?: number;
	/** Characters kept per message. */
	maxMessageChars?: number;
}

export interface HistoryReadMessage {
	entryId: string;
	role: "user" | "assistant";
	ts: number;
	onBranch: boolean;
	stopReason?: HistoryRecord["stopReason"];
	text: string;
	truncated: boolean;
	focus: boolean;
}

export interface HistoryReadResult {
	path: string;
	sessionId: string;
	title?: string;
	cwd: string;
	mode: "coding" | "general";
	handoff: {
		state: HandoffState;
		summary?: string;
		coveredEntryId?: string;
		updatedAt?: string;
		uncoveredCount: number;
	};
	/** Present when an entry id was asked for. */
	focus?: { entryId: string; found: boolean; onBranch: boolean };
	messages: HistoryReadMessage[];
	/** Messages of the current branch after the last one returned (later corrections live there). */
	laterOnBranch: number;
	/** Messages of the current branch in total. */
	branchMessages: number;
}

const DEFAULT_MESSAGE_CHARS = 4000;

function childrenIndex(entries: readonly SessionEntry[]): Map<string | null, SessionEntry[]> {
	const children = new Map<string | null, SessionEntry[]>();
	for (const entry of entries) {
		const list = children.get(entry.parentId) ?? [];
		list.push(entry);
		children.set(entry.parentId, list);
	}
	return children;
}

/** Root → entry → (the branch it continues on): ids in conversation order. */
function lineThrough(entries: readonly SessionEntry[], focusId: string, branch: ReadonlySet<string>): string[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const up: string[] = [];
	const seen = new Set<string>();
	let current = byId.get(focusId);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		up.push(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	up.reverse();
	const children = childrenIndex(entries);
	let cursor = focusId;
	for (let guard = 0; guard < entries.length; guard++) {
		const next = children.get(cursor);
		if (!next?.length) break;
		// Stay on the current branch when the entry is on it; otherwise follow the newest continuation.
		const pick = next.find((child) => branch.has(child.id)) ?? next[next.length - 1]!;
		if (seen.has(pick.id)) break;
		seen.add(pick.id);
		up.push(pick.id);
		cursor = pick.id;
	}
	return up;
}

export function readSessionHistory(options: HistoryReadOptions): HistoryReadResult | undefined {
	const set = loadHistoryRecords(options.path);
	if (!set) return undefined;
	const maxChars = Math.max(200, options.maxMessageChars ?? DEFAULT_MESSAGE_CHARS);
	const handoff = handoffStatus(readHandoff(options.path), set);
	const byId = new Map(set.records.map((record) => [record.id, record]));
	const branchRecords = set.records.filter((record) => record.onBranch);
	const toMessage = (record: HistoryRecord, focusId?: string): HistoryReadMessage => ({
		entryId: record.id,
		role: record.role,
		ts: record.ts,
		onBranch: record.onBranch,
		...(record.stopReason ? { stopReason: record.stopReason } : {}),
		text: record.text.length > maxChars ? `${record.text.slice(0, maxChars)}…` : record.text,
		truncated: record.text.length > maxChars,
		focus: record.id === focusId,
	});
	const base = {
		path: options.path,
		sessionId: set.sessionId,
		title: set.title,
		cwd: set.cwd,
		mode: set.mode,
		handoff: {
			state: handoff.state,
			summary: handoff.record?.summary,
			coveredEntryId: handoff.record?.coveredEntryId,
			updatedAt: handoff.record?.updatedAt,
			uncoveredCount: handoff.uncovered.length,
		},
		branchMessages: branchRecords.length,
	};
	const laterThan = (last: HistoryReadMessage | undefined): number => {
		if (!last) return 0;
		const at = branchRecords.findIndex((record) => record.id === last.entryId);
		return at < 0 ? 0 : branchRecords.length - at - 1;
	};

	if (!options.entryId) {
		const tail = Math.max(1, Math.min(40, Math.floor(options.tail ?? 6)));
		const messages = branchRecords.slice(-tail).map((record) => toMessage(record));
		return { ...base, messages, laterOnBranch: 0 };
	}

	const focusRecord = byId.get(options.entryId);
	if (!focusRecord) {
		return {
			...base,
			focus: { entryId: options.entryId, found: false, onBranch: false },
			messages: [],
			laterOnBranch: 0,
		};
	}
	const entries = loadEntriesFromFile(options.path).slice(1) as SessionEntry[];
	const branch = new Set(branchRecords.map((record) => record.id));
	const line = lineThrough(entries, focusRecord.id, branch).flatMap((id) => {
		const record = byId.get(id);
		return record ? [record] : [];
	});
	const at = line.findIndex((record) => record.id === focusRecord.id);
	const before = Math.max(0, Math.min(20, Math.floor(options.before ?? 3)));
	const after = Math.max(0, Math.min(20, Math.floor(options.after ?? 3)));
	const messages = line
		.slice(Math.max(0, at - before), at + after + 1)
		.map((record) => toMessage(record, focusRecord.id));
	return {
		...base,
		focus: { entryId: focusRecord.id, found: true, onBranch: focusRecord.onBranch },
		messages,
		laterOnBranch: focusRecord.onBranch ? laterThan(messages.at(-1)) : 0,
	};
}
