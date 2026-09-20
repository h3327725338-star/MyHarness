import type { AgentMessage } from "@myharness/agent-core";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../../agent/runtime/messages.ts";
import {
	type CompactionUserAnchor,
	renderCompactionContinuity,
	type ToolExecutionRecord,
} from "../../context/compact/utils.ts";
import type { CompactionEntry, SessionContext, SessionEntry } from "../types.ts";

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return entries[i] as CompactionEntry;
	}
	return null;
}

export class SessionParentCycleError extends Error {
	readonly cycleIds: string[];

	constructor(cycleIds: string[], sessionFile?: string) {
		const location = sessionFile ? ` in ${sessionFile}` : "";
		super(
			`Session parent chain is cyclic${location}: ${[...cycleIds, cycleIds[0]].join(" -> ")}. ` +
				"The session file was not modified; repair or remove the cyclic parentId before resuming.",
		);
		this.name = "SessionParentCycleError";
		this.cycleIds = cycleIds;
	}
}

export function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) index.set(entry.id, entry);
	return index;
}

/** Walk a leaf's parent chain in root-first order, detecting corrupted cycles. */
export function walkSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	options: { fallbackToLastEntry?: boolean; sessionFile?: string } = {},
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) return [];
	if (leafId) {
		leaf = index.get(leafId);
		if (!leaf && !options.fallbackToLastEntry) return [];
	}
	leaf ??= entries[entries.length - 1];
	if (!leaf) return [];

	const path: SessionEntry[] = [];
	const visited = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current) {
		if (visited.has(current.id)) {
			const walkedIds = path.map((entry) => entry.id);
			const cycleStart = walkedIds.indexOf(current.id);
			throw new SessionParentCycleError(
				cycleStart >= 0 ? walkedIds.slice(cycleStart) : [current.id],
				options.sessionFile,
			);
		}
		visited.add(current.id);
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
		else if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
		else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/** Convert one persisted entry into messages consumed by the runtime context. */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(
				entry.customType,
				entry.content ?? [],
				entry.display,
				entry.details,
				entry.timestamp,
				entry.excludeFromContext,
			),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		if (entry.replacementHistory) return entry.replacementHistory;
		const details = entry.details as
			| { userAnchors?: CompactionUserAnchor[]; executions?: ToolExecutionRecord[] }
			| undefined;
		const continuity = renderCompactionContinuity(details?.userAnchors, details?.executions);
		const summary = continuity ? `${entry.summary}\n\n${continuity}` : entry.summary;
		return [createCompactionSummaryMessage(summary, entry.tokensBefore, entry.timestamp)];
	}
	return [];
}

/** Build the active branch after applying the latest compaction checkpoint. */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	options: { sessionFile?: string } = {},
): SessionEntry[] {
	const path = walkSessionPath(entries, leafId, byId, { fallbackToLastEntry: true, ...options });
	let compaction: CompactionEntry | null = null;
	for (const entry of path) if (entry.type === "compaction") compaction = entry;
	if (!compaction) return path;

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) return path;
	if (compaction.replacementHistory) return [compaction, ...path.slice(compactionIdx + 1)];

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept && entry.type !== "compaction") contextEntries.push(entry);
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

/** Project persisted entries into the runtime context and model state. */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	options: { sessionFile?: string } = {},
): SessionContext {
	const path = walkSessionPath(entries, leafId, byId, { fallbackToLastEntry: true, ...options });
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const messages = buildContextEntries(entries, leafId, byId, options).flatMap(sessionEntryToContextMessages);
	return { messages, thinkingLevel, model };
}
