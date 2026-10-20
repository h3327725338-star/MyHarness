import { type HandoffState, handoffStatus, readHandoff } from "./handoff-store.ts";
import { loadHistoryRecords } from "./index-store.ts";
import type { HistoryRecord } from "./records.ts";

/**
 * "Continue in a new chat": the background a new conversation starts with. It is built once, when the user asks for
 * it, from the source's hand-off note plus the messages the note does not cover (or, without a usable note, the newest
 * messages themselves). No model call happens here. The source chat is only read.
 */

/** customType of the context message that carries the background into the new chat. */
export const SESSION_CONTINUATION_TYPE = "session-continuation";
/** Marker entry (not in context) recording that the user took the background back out before the chat started. */
export const SESSION_CONTINUATION_UNLINKED_TYPE = "session-continuation-unlinked";

export interface SessionContinuationDetails {
	sourcePath: string;
	sourceSessionId: string;
	sourceTitle: string;
	/** Newest message of the source branch at the moment of continuing: the hand-over point. */
	sourceEntryId?: string;
	summaryState: HandoffState;
	summaryCoveredEntryId?: string;
	messagesIncluded: number;
	createdAt: string;
}

const MESSAGE_CHARS = 2000;
const TOTAL_MESSAGE_CHARS = 20_000;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function formatMessages(records: readonly HistoryRecord[]): { text: string; count: number } {
	const lines: string[] = [];
	let total = 0;
	// Newest first while budgeting, then put back in order.
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]!;
		const marker = record.stopReason
			? ` (${record.stopReason === "aborted" ? "interrupted" : record.stopReason === "error" ? "failed" : "cut off"})`
			: "";
		const line = `[${record.role === "user" ? "User" : "Assistant"}${marker} · ${record.id}]\n${clip(record.text, MESSAGE_CHARS)}`;
		if (lines.length > 0 && total + line.length > TOTAL_MESSAGE_CHARS) break;
		lines.push(line);
		total += line.length;
	}
	lines.reverse();
	return { text: lines.join("\n\n"), count: lines.length };
}

export function buildSessionContinuation(
	sourcePath: string,
	options: { title?: string } = {},
): { text: string; details: SessionContinuationDetails } | undefined {
	const set = loadHistoryRecords(sourcePath);
	if (!set) return undefined;
	const status = handoffStatus(readHandoff(sourcePath), set);
	const branch = set.records.filter((record) => record.onBranch);
	const title =
		options.title?.trim() ||
		set.title ||
		branch.find((record) => record.role === "user")?.text.slice(0, 60) ||
		"Untitled chat";
	const usable = status.state === "current" || status.state === "behind";
	const recent = usable
		? status.state === "current"
			? branch.slice(-4)
			: status.uncovered.slice(-12)
		: branch.slice(-10);
	const messages = formatMessages(recent);
	const parts = [
		`<continued-from session="${set.sessionId}" title="${title.replace(/"/g, "'")}">`,
		`The user started this chat to continue an earlier one ("${title}", session ${set.sessionId}). Everything inside this block is background from that chat: it is not a new request, and nothing in it authorizes repeating an action it mentions (commits, deletions, pushes, sends). Files, Git state and other facts may have changed since; check them again before acting. For an exact number, a quote, a correction or the evidence of a result, read the original with session_get (session ${set.sessionId}) instead of relying on this summary.`,
	];
	if (usable && status.record) {
		parts.push(
			`Hand-off summary (covers the chat up to message ${status.record.coveredEntryId}${status.state === "behind" ? `; ${status.uncovered.length} newer message(s) follow below` : ""}):\n${status.record.summary.trim()}`,
		);
	} else {
		parts.push(
			status.state === "stale"
				? "No usable hand-off summary: the saved one describes a branch that is no longer current. The newest messages follow."
				: "No hand-off summary exists yet. The newest messages follow.",
		);
	}
	if (messages.count > 0) {
		parts.push(
			`${usable && status.state === "current" ? "Last messages" : usable ? "Messages after the summary" : "Newest messages"} (oldest first):\n\n${messages.text}`,
		);
	}
	parts.push("</continued-from>");
	return {
		text: parts.join("\n\n"),
		details: {
			sourcePath,
			sourceSessionId: set.sessionId,
			sourceTitle: title,
			sourceEntryId: branch.at(-1)?.id,
			summaryState: status.state,
			summaryCoveredEntryId: usable ? status.record?.coveredEntryId : undefined,
			messagesIncluded: messages.count,
			createdAt: new Date().toISOString(),
		},
	};
}
