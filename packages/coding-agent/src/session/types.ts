import type { AgentMessage } from "@myharness/agent-core";
import type { ImageContent, TextContent, Usage } from "@myharness/ai";

/** The on-disk Session JSONL format version. Keep at v3 for compatibility. */
export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	/** Stable Data Framework Workspace identity. Optional for legacy sessions. */
	workspaceId?: string;
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
	replacementHistory?: AgentMessage[];
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

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

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	workspaceId?: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type SessionListProgress = (loaded: number, total: number) => void;

/** Narrow, read-only capability surface exposed to context/application code. */
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
