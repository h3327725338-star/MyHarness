import type { AgentMessage } from "@myharness/agent-core";
import type { ImageContent, TextContent, Usage } from "@myharness/ai";

/** The on-disk Session JSONL format version. Keep at v3 for compatibility. */
export const CURRENT_SESSION_VERSION = 3;

export type ChatMode = "coding" | "general";

/** Missing mode in legacy data always means Coding. */
export function getChatMode(value: { mode?: unknown } | null | undefined): ChatMode {
	return value?.mode === "general" ? "general" : "coding";
}

/**
 * First line of a Session JSONL file. Authoritative identity for resume/listing.
 *
 * Only `SessionManager` and `storage/jsonl` write it; readers must tolerate legacy
 * headers without `mode`/`workspaceId`.
 */
export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	/** Immutable chat mode; absent in legacy Coding sessions. */
	mode?: ChatMode;
	/** Stable Data Framework Workspace identity. Optional for legacy sessions. */
	workspaceId?: string;
	parentSession?: string;
}

/** Options for starting a fresh Session; `id` must pass `assertValidSessionId`. */
export interface NewSessionOptions {
	mode?: ChatMode;
	id?: string;
	parentSession?: string;
}

/**
 * Common shape of every append-only tree entry. `parentId` links the branch tree;
 * `null` means a root. Entries are never edited in place — branching only moves the leaf.
 */
export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

/** Optional measured durations; absent fields in legacy records mean unknown, never zero. */
export interface SessionMessageTiming {
	/** Provider API duration; excludes Agent preparation and event consumers. */
	providerRequestMs?: number;
	requestMs?: number;
	firstOutputMs?: number;
	generationMs?: number;
	toolMs?: number;
}

/** One persisted agent message. `timing` is product metadata, never sent to the model. */
export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
	/** Product metadata, never sent to the model. */
	timing?: SessionMessageTiming;
}

/** Thinking-level switch on the active branch; later entries inherit it until the next switch. */
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

/** Model switch on the active branch; later entries inherit it until the next switch. */
export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

/**
 * Compaction checkpoint. `firstKeptEntryId` is the first pre-checkpoint entry that stays
 * visible; `replacementHistory` (when present) replaces the whole pre-checkpoint context.
 * `details`/`usage` are diagnostics, never the billing source unless `usageSource` says so.
 */
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	/** Actual billing source at request time; absent in legacy or extension-owned records. */
	usageSource?: { provider: string; model: string; currency: "USD" | "CNY" };
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
	replacementHistory?: AgentMessage[];
}

/** Summary of an abandoned branch path; on the active path it enters model context as a `branchSummary` message. */
export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
}

/** Extension-owned entry. Unknown `customType` values must be preserved and ignored by projection. */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/** Bookmark marker for `targetId`. An absent/empty `label` clears the bookmark. */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** Display name record. The latest record wins; an empty `name` clears the title. */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * Extension message that may enter model context. `display` controls Web UI visibility only;
 * `excludeFromContext` keeps it persisted but out of the LLM context.
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
	excludeFromContext?: boolean;
}

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

/** Recoverable problems found while reading a Session JSONL file. */
export type SessionJsonlIssueKind = "truncated_tail" | "malformed_line" | "schema_invalid";

export interface SessionJsonlDiagnostic {
	filePath: string;
	line: number;
	kind: SessionJsonlIssueKind;
	message: string;
}

export interface SessionJsonlDiagnostics {
	recovered: boolean;
	issues: SessionJsonlDiagnostic[];
}

/** A non-fatal failure while updating discovery metadata beside authoritative JSONL. */
export interface SessionMetadataDiagnostic {
	sessionId: string;
	workspaceId: string;
	metadataPath: string;
	message: string;
	timestamp: string;
}

/** One tree node with resolved bookmark label; `children` are sorted oldest-first by `getTree()`. */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

/** Resolved runtime context for one leaf: model messages plus the effective thinking/model state. */
export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	mode?: ChatMode;
	path: string;
	id: string;
	workspaceId?: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	/**
	 * The file holds nothing the user made: besides the header only the model and thinking setup written when the
	 * chat was created (no message, name, label, operation card or other entry).
	 */
	blank?: boolean;
	firstMessage: string;
	allMessagesText: string;
}

export type SessionListProgress = (loaded: number, total: number) => void;

/** Narrow, read-only capability surface exposed to context code and extensions. */
export interface ReadonlySessionManager {
	getCwd(): string;
	getSessionDir(): string;
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
	getLabel(id: string): string | undefined;
	getBranch(fromId?: string): SessionEntry[];
	buildContextEntries(): SessionEntry[];
	getHeader(): SessionHeader | null;
	getEntries(): SessionEntry[];
	getTree(): SessionTreeNode[];
	getSessionName(): string | undefined;
	getLoadDiagnostics(): SessionJsonlDiagnostics | undefined;
	getMetadataDiagnostics(): readonly SessionMetadataDiagnostic[];
}
