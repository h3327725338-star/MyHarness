import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionMetadataDir, parseSessionDataPath } from "../../config/paths/index.ts";
import { writeFileAtomicallySync } from "../../utils/atomic-write.ts";
import type { HistoryRecord, HistoryRecordSet } from "./records.ts";

/**
 * The hand-off note of one conversation: a short summary of where the chat stands, kept next to the session as
 * derived data (`metadata/handoff.json`). It is never the evidence itself; the JSONL stays the source of truth and the
 * note records exactly which message it covers, so readers can tell when it fell behind or no longer applies.
 */

export const HANDOFF_FILE_NAME = "handoff.json";
export const HANDOFF_VERSION = 1;

export interface HandoffRecord {
	version: typeof HANDOFF_VERSION;
	sessionId: string;
	summary: string;
	/** Last message (user or assistant) the summary covers, on the branch it was written for. */
	coveredEntryId: string;
	/** Branch messages covered, for display only. */
	coveredCount: number;
	provider?: string;
	model?: string;
	updatedAt: string;
}

export type HandoffState = "missing" | "current" | "behind" | "stale";

export interface HandoffStatus {
	state: HandoffState;
	record?: HandoffRecord;
	/** Branch messages the summary does not cover (all of them when missing or stale). */
	uncovered: HistoryRecord[];
}

export function handoffPath(conversationFile: string): string | undefined {
	const scope = parseSessionDataPath(conversationFile);
	if (!scope) return undefined;
	return join(getSessionMetadataDir(scope.dataRoot, scope.workspaceId, scope.sessionId), HANDOFF_FILE_NAME);
}

function isRecord(value: unknown): value is HandoffRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<HandoffRecord>;
	return (
		record.version === HANDOFF_VERSION &&
		typeof record.sessionId === "string" &&
		typeof record.summary === "string" &&
		typeof record.coveredEntryId === "string" &&
		typeof record.updatedAt === "string"
	);
}

export function readHandoff(conversationFile: string): HandoffRecord | undefined {
	const path = handoffPath(conversationFile);
	if (!path) return undefined;
	try {
		if (lstatSync(path).isSymbolicLink()) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? { ...parsed, coveredCount: Number(parsed.coveredCount) || 0 } : undefined;
	} catch {
		return undefined;
	}
}

/** Atomic write. Returns false for a conversation outside the structured data layout (nothing is written). */
export function writeHandoff(conversationFile: string, record: HandoffRecord): boolean {
	const path = handoffPath(conversationFile);
	if (!path) return false;
	mkdirSync(join(path, ".."), { recursive: true });
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error("Refusing to write the hand-off note through a link.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	writeFileAtomicallySync(path, JSON.stringify(record, null, 2));
	return true;
}

/** How a stored note relates to the conversation as it is now (its current branch). */
export function handoffStatus(record: HandoffRecord | undefined, set: HistoryRecordSet): HandoffStatus {
	const branch = set.records.filter((item) => item.onBranch);
	if (!record || record.sessionId !== set.sessionId) return { state: "missing", uncovered: branch };
	const index = branch.findIndex((item) => item.id === record.coveredEntryId);
	// The covered message left the branch (navigation, edit-and-resend): the note describes another path.
	if (index < 0) return { state: "stale", record, uncovered: branch };
	const uncovered = branch.slice(index + 1);
	return { state: uncovered.length === 0 ? "current" : "behind", record, uncovered };
}
