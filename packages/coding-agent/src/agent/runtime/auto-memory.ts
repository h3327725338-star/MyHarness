import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { contentText } from "@myharness/ai";
import { stringify as stringifyYaml } from "yaml";
import { getDataDir, UNBOUND_WORKSPACE_ID } from "../../config/paths/index.ts";
import type { AutoMemorySettings, SettingsManager } from "../../config/settings/index.ts";
import { getAgentDir } from "../../config.ts";
import { runGitSync } from "../../git/repository/command.ts";
import type { ModelRuntime } from "../../providers/runtime/index.ts";
import { sdkFirstByteTimeoutMs } from "../../providers/runtime/request-timeouts.ts";
import { assertDirectPath } from "../../session/artifacts/store.ts";
import {
	archiveMemoryFile,
	getMemoryPaths,
	migrateLegacyMemories,
	refreshMemoryIndexes,
	withMemoryLock,
	writeMemoryFile,
} from "../../session/memory/store.ts";
import type { SessionEntry } from "../../session/types.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { type MainModelRef, resolveAssistantModel } from "./assistant-model.ts";
import type { CustomMessage } from "./messages.ts";

export type MemoryScope = "global" | "workspace" | "session" | "project";
export type MemoryType = "user" | "feedback" | "project" | "reference";
/** Sort weight of a memory: high 1.3, normal 1.0, low 0.7. A missing field means normal. */
export type MemoryImportance = "high" | "normal" | "low";

export interface MemoryEntry {
	id: string;
	name: string;
	description: string;
	type: MemoryType;
	scope: MemoryScope;
	content: string;
	createdAt: string;
	updatedAt: string;
	filePath: string;
	/** Optional frontmatter field; absent in older files and kept absent when they are rewritten. */
	importance?: MemoryImportance;
	/** Optional frontmatter field: phrases the user really says. A match recalls the memory directly. */
	triggers?: string[];
	workspaceId?: string;
	sessionId?: string;
	sourceEntryId?: string;
	sourceWorkspaceId?: string;
	sourceSessionId?: string;
}

export interface MemoryOperation {
	action: "upsert" | "delete";
	id?: string;
	scope?: MemoryScope;
	type?: MemoryType;
	name?: string;
	description?: string;
	content?: string;
	importance?: MemoryImportance;
	triggers?: string[];
}

interface MemoryState {
	version: 1;
	sessions: Record<string, { lastEntryId?: string; updatedAt: string }>;
	consolidation: Record<
		string,
		{ lastAt?: string; sessionIds: string[]; pendingChanges?: number; pendingSince?: string; revision?: number }
	>;
}

interface AutoMemoryPaths {
	root: string;
	globalDir: string;
	projectDir: string;
	sessionDir: string;
	dataRoot: string;
	workspaceId: string;
	sessionId: string;
	indexPath: string;
	statePath: string;
	projectRoot: string;
	projectKey: string;
}

interface AutoMemoryManagerOptions {
	cwd: string;
	sessionId: string;
	settingsManager: SettingsManager;
	modelRuntime?: ModelRuntime;
	/** The main session model, inherited when Auto Memory has no model of its own. */
	getMainModel?: () => MainModelRef | undefined;
	persisted: boolean;
	agentDir?: string;
	dataRoot?: string;
	workspaceId?: string;
	onError?: (operation: "recall" | "extract" | "consolidate", error: Error) => void;
	onStatus?: (status: MemoryMaintenanceStatus) => void;
	modelRunner?: AutoMemoryModelRunner;
}

export interface MemoryMaintenanceStatus {
	phase: "idle" | "pending" | "processing" | "warning";
	error?: string;
}

interface MemoryMaintenanceJob {
	version: 1;
	id: string;
	entries: SessionEntry[];
	attempts: number;
}

export type AutoMemoryModelRunner = (options: {
	cwd: string;
	settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>;
	systemPrompt: string;
	task: string;
}) => Promise<string>;

// 8KB so the resident user profile fits in one entry; ordinary entries are still asked to stay short.
const MEMORY_BODY_MAX_BYTES = 8 * 1024;
const MEMORY_TRIGGER_MAX_COUNT = 6;
const MEMORY_TRIGGER_MAX_BYTES = 60;
const MAX_DIRECT_TRIGGER_MEMORIES = 3;
const MEMORY_IMPORTANCE_WEIGHT: Record<MemoryImportance, number> = { high: 1.3, normal: 1, low: 0.7 };
const MEMORY_IMPORTANCES = new Set<MemoryImportance>(["high", "normal", "low"]);
/** The one global entry the consolidator maintains; it is sent with every turn instead of being ranked. */
export const MEMORY_PROFILE_ID = "global/用户画像";
const RECALL_TURN_MAX_BYTES = 20 * 1024;
// 维护记忆 Agent 的输入不设上限：提取时的聊天全文、已有记忆清单、整理时的整批记忆全部送给模型，
// 只有输出侧保留上限（单次模型输出 maxTokens、单条记忆正文 8KB）。主聊天的召回仍保留 20KB 保护，不在此列。
const MAX_RECALLED_MEMORIES = 5;
const CONSOLIDATION_MIN_CHANGES = 5;
const CONSOLIDATION_INTERVAL_MS = 3 * 60 * 60 * 1000;
const AUTO_MEMORY_TIMEOUT_MS = 15 * 60 * 1000;
const MEMORY_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const MEMORY_SCOPES = new Set<MemoryScope>(["global", "workspace", "session", "project"]);

const MEMORY_CONTEXT_RULES = loadSystemPrompt("memory/recalled-context.md");

export const AUTO_MEMORY_SYSTEM_PROMPT = loadSystemPrompt("session/auto-memory.md");

const MEMORY_EXTRACTOR_PROMPT = loadSystemPrompt("memory/extractor.md");

const MEMORY_CONSOLIDATOR_PROMPT = loadSystemPrompt("memory/consolidator.md");

function resolveProjectRoot(cwd: string): string {
	try {
		const result = runGitSync(["rev-parse", "--show-toplevel"], {
			cwd,
			timeoutMs: 5_000,
		});
		if (result.ok && result.stdout) {
			return path.resolve(result.stdout);
		}
	} catch {
		// A non-Git working directory is a valid project scope.
	}
	return path.resolve(cwd);
}

export function getAutoMemoryPaths(
	cwd: string,
	agentDir = getAgentDir(),
	location?: { dataRoot: string; workspaceId: string; sessionId: string },
): AutoMemoryPaths {
	const projectRoot = resolveProjectRoot(cwd);
	const normalizedRoot = process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot;
	const projectKey = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 20);
	const resolved = location ?? { dataRoot: getDataDir(), workspaceId: UNBOUND_WORKSPACE_ID, sessionId: "legacy" };
	void agentDir; // Retained for callers of the former path API; no data is stored here.
	const paths = getMemoryPaths(resolved);
	return {
		...paths,
		projectDir: paths.workspaceDir,
		dataRoot: resolved.dataRoot,
		workspaceId: resolved.workspaceId,
		sessionId: resolved.sessionId,
		projectRoot,
		projectKey,
	};
}

function emptyState(): MemoryState {
	return {
		version: 1,
		sessions: {},
		consolidation: {},
	};
}

function truncateUtf8(value: string, maxBytes: number): string {
	const normalized = value.trim();
	if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
	let end = normalized.length;
	while (end > 0 && Buffer.byteLength(normalized.slice(0, end), "utf8") > maxBytes) end--;
	return normalized.slice(0, end).trimEnd();
}

export function sanitizeMemoryText(value: string): string {
	if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)) {
		throw new Error("记忆内容包含私钥，已拒绝保存");
	}
	return value
		.replace(
			/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b(\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
			(_match, key: string, separator: string, quote: string) => `${key}${separator}${quote}[已移除敏感值]`,
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [已移除敏感值]")
		.trim();
}

function slugify(value: string): string {
	const slug = value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || `memory-${randomUUID().slice(0, 8)}`;
}

export function isSafeMemoryId(id: string): boolean {
	return /^(global|workspace|session|project)\/[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(id);
}

function readImportance(value: unknown): MemoryImportance | undefined {
	return typeof value === "string" && MEMORY_IMPORTANCES.has(value as MemoryImportance)
		? (value as MemoryImportance)
		: undefined;
}

/**
 * Trigger phrases from a frontmatter value or a model operation: collapse whitespace, cut each to the byte limit,
 * drop empty or repeated ones and keep the first six. Oversized input is trimmed, never rejected.
 */
function normalizeTriggers(value: unknown, clean: (text: string) => string = (text) => text): string[] {
	const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	const triggers: string[] = [];
	for (const item of items) {
		if (typeof item !== "string") continue;
		let text: string;
		try {
			text = truncateUtf8(clean(item.replace(/\s+/g, " ")), MEMORY_TRIGGER_MAX_BYTES);
		} catch {
			continue; // A trigger carrying a secret is dropped; the rest of the memory is still valid.
		}
		if (text && !triggers.includes(text)) triggers.push(text);
		if (triggers.length >= MEMORY_TRIGGER_MAX_COUNT) break;
	}
	return triggers;
}

function parseMemoryFile(filePath: string, expectedScope: MemoryScope): MemoryEntry | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = parseFrontmatter<Record<string, unknown>>(raw);
		const id = typeof parsed.frontmatter.id === "string" ? parsed.frontmatter.id : "";
		const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : "";
		const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "";
		const type = parsed.frontmatter.type;
		const scope = parsed.frontmatter.scope;
		if (
			!isSafeMemoryId(id) ||
			!name.trim() ||
			!description.trim() ||
			typeof type !== "string" ||
			!MEMORY_TYPES.has(type as MemoryType) ||
			scope !== expectedScope
		) {
			return undefined;
		}
		// importance and triggers are optional: a file without them (or with unusable values) is still a valid memory.
		const triggers = normalizeTriggers(parsed.frontmatter.triggers);
		return {
			id,
			name: name.trim(),
			description: description.trim(),
			type: type as MemoryType,
			scope: expectedScope,
			content: truncateUtf8(parsed.body, MEMORY_BODY_MAX_BYTES),
			createdAt:
				typeof parsed.frontmatter.createdAt === "string" ? parsed.frontmatter.createdAt : new Date(0).toISOString(),
			updatedAt:
				typeof parsed.frontmatter.updatedAt === "string" ? parsed.frontmatter.updatedAt : new Date(0).toISOString(),
			filePath,
			importance: readImportance(parsed.frontmatter.importance),
			triggers: triggers.length > 0 ? triggers : undefined,
			workspaceId: typeof parsed.frontmatter.workspaceId === "string" ? parsed.frontmatter.workspaceId : undefined,
			sessionId: typeof parsed.frontmatter.sessionId === "string" ? parsed.frontmatter.sessionId : undefined,
			sourceEntryId:
				typeof parsed.frontmatter.sourceEntryId === "string" ? parsed.frontmatter.sourceEntryId : undefined,
			sourceWorkspaceId:
				typeof parsed.frontmatter.sourceWorkspaceId === "string" ? parsed.frontmatter.sourceWorkspaceId : undefined,
			sourceSessionId:
				typeof parsed.frontmatter.sourceSessionId === "string" ? parsed.frontmatter.sourceSessionId : undefined,
		};
	} catch {
		return undefined;
	}
}

function scanMemoryDirectory(directory: string, scope: MemoryScope): MemoryEntry[] {
	assertDirectPath(directory);
	if (!fs.existsSync(directory)) return [];
	const entries: MemoryEntry[] = [];
	for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
		if (!item.isFile() || !item.name.endsWith(".md")) continue;
		assertDirectPath(path.join(directory, item.name));
		const entry = parseMemoryFile(path.join(directory, item.name), scope);
		if (entry) entries.push(entry);
	}
	return entries;
}

/**
 * Read the active memories visible to one conversation: global, its workspace and its own. Read-only; archive/,
 * pending/ and other workspaces or conversations are never scanned. Newest first.
 */
export function readMemoryEntries(directories: {
	globalDir: string;
	projectDir: string;
	sessionDir: string;
}): MemoryEntry[] {
	return [
		...scanMemoryDirectory(directories.globalDir, "global"),
		...scanMemoryDirectory(directories.projectDir, "workspace"),
		...scanMemoryDirectory(directories.sessionDir, "session"),
	].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function serializeMemory(entry: MemoryEntry): string {
	// Every optional field must be listed here: this writer is a whitelist, so anything left out is erased on update.
	const frontmatter = stringifyYaml({
		id: entry.id,
		name: entry.name,
		description: entry.description,
		type: entry.type,
		scope: entry.scope,
		importance: entry.importance,
		triggers: entry.triggers?.length ? entry.triggers : undefined,
		workspaceId: entry.workspaceId,
		sessionId: entry.sessionId,
		sourceEntryId: entry.sourceEntryId,
		sourceWorkspaceId: entry.sourceWorkspaceId,
		sourceSessionId: entry.sourceSessionId,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	}).trim();
	return `---\n${frontmatter}\n---\n\n${entry.content}\n`;
}

function readState(statePath: string): MemoryState {
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<MemoryState>;
		if (parsed.version !== 1 || !parsed.sessions || !parsed.consolidation) return emptyState();
		const sessions: MemoryState["sessions"] = {};
		for (const [sessionId, value] of Object.entries(parsed.sessions)) {
			if (!value || typeof value !== "object" || typeof value.updatedAt !== "string") continue;
			sessions[sessionId] = {
				lastEntryId: typeof value.lastEntryId === "string" ? value.lastEntryId : undefined,
				updatedAt: value.updatedAt,
			};
		}
		const consolidation: MemoryState["consolidation"] = {};
		for (const [projectKey, value] of Object.entries(parsed.consolidation)) {
			if (!value || typeof value !== "object" || !Array.isArray(value.sessionIds)) continue;
			consolidation[projectKey] = {
				lastAt: typeof value.lastAt === "string" ? value.lastAt : undefined,
				sessionIds: value.sessionIds.filter((id): id is string => typeof id === "string"),
				pendingChanges: typeof value.pendingChanges === "number" ? Math.max(0, value.pendingChanges) : undefined,
				pendingSince: typeof value.pendingSince === "string" ? value.pendingSince : undefined,
				revision: typeof value.revision === "number" ? value.revision : 0,
			};
		}
		return {
			version: 1,
			sessions,
			consolidation,
		};
	} catch {
		return emptyState();
	}
}

export function parseMemoryOperations(output: string): MemoryOperation[] | undefined {
	const tagged = /<MEMORY_OPERATIONS>\s*([\s\S]*?)\s*<\/MEMORY_OPERATIONS>/i.exec(output)?.[1];
	const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(tagged ?? output)?.[1];
	const rawCandidates = [tagged, fenced, output.trim()].filter(
		(value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
	);

	for (const raw of rawCandidates) {
		const trimmed = raw.trim();
		const firstBrace = trimmed.indexOf("{");
		const lastBrace = trimmed.lastIndexOf("}");
		const candidates =
			firstBrace >= 0 && lastBrace > firstBrace ? [trimmed, trimmed.slice(firstBrace, lastBrace + 1)] : [trimmed];
		for (const candidate of candidates) {
			try {
				const parsed = JSON.parse(candidate) as { operations?: unknown };
				if (!Array.isArray(parsed.operations)) continue;
				return parsed.operations.slice(0, 20).filter((value): value is MemoryOperation => {
					if (!value || typeof value !== "object") return false;
					const operation = value as Partial<MemoryOperation>;
					return operation.action === "upsert" || operation.action === "delete";
				});
			} catch {
				// Try the next safe JSON candidate.
			}
		}
	}
	return undefined;
}

export function parseMemorySelection(output: string): string[] | undefined {
	const match = /<MEMORY_SELECTION>\s*([\s\S]*?)\s*<\/MEMORY_SELECTION>/i.exec(output);
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match[1]) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		return parsed.filter((value): value is string => typeof value === "string").slice(0, MAX_RECALLED_MEMORIES);
	} catch {
		return undefined;
	}
}

function formatManifest(entries: MemoryEntry[]): string {
	// 输入不设上限：已有记忆清单全部送给提取器，不再按 16KB 截断。
	const rows: Array<Record<string, unknown>> = [];
	for (const { id, name, description, type, scope, updatedAt, importance, triggers } of entries) {
		// Show existing annotations so the memory model keeps them instead of rewriting or duplicating the entry.
		const row = {
			id,
			name,
			description,
			type,
			scope,
			updatedAt,
			...(importance ? { importance } : {}),
			...(triggers?.length ? { triggers } : {}),
		};
		rows.push(row);
	}
	return JSON.stringify(rows, null, 2);
}

function lexicalTerms(value: string): Set<string> {
	const terms = new Set<string>();
	for (const token of value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) {
		terms.add(token);
		const hanCharacters = [...token].filter((character) => /\p{Script=Han}/u.test(character));
		for (let index = 0; index < hanCharacters.length - 1; index++) {
			terms.add(`${hanCharacters[index]}${hanCharacters[index + 1]}`);
		}
	}
	return terms;
}

/** Whether this is the resident user profile, which is sent every turn rather than ranked against the query. */
export function isMemoryProfile(entry: Pick<MemoryEntry, "id" | "scope">): boolean {
	return entry.scope === "global" && entry.id === MEMORY_PROFILE_ID;
}

function importanceWeight(entry: MemoryEntry): number {
	return MEMORY_IMPORTANCE_WEIGHT[entry.importance ?? "normal"];
}

function memoryFingerprint(entry: MemoryEntry): string {
	return `${entry.scope}:${entry.content.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/** TF-IDF relevance of every entry that shares a term with the query, times its importance weight, best first. */
function rankLexically(queryTerms: Set<string>, entries: MemoryEntry[]): Array<{ entry: MemoryEntry; score: number }> {
	if (queryTerms.size === 0) return [];
	const documents = entries.map((entry) => ({
		entry,
		terms: lexicalTerms(`${entry.name}\n${entry.description}\n${entry.content}`),
	}));
	const frequencies = new Map<string, number>();
	for (const document of documents) {
		for (const term of queryTerms)
			if (document.terms.has(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
	}
	return documents
		.map(({ entry, terms: documentTerms }) => {
			let score = 0;
			for (const term of queryTerms) {
				if (documentTerms.has(term)) score += Math.log(1 + entries.length / (frequencies.get(term) ?? 1));
			}
			return { entry, score: (score / Math.sqrt(Math.max(1, documentTerms.size))) * importanceWeight(entry) };
		})
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));
}

function compactForMatch(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * How many of an entry's trigger phrases the query matches. A Chinese phrase matches when the whole phrase is
 * contained in the query or enough of its two-character groups are; a Latin phrase matches when every one of its
 * words is a whole word of the query, so a short abbreviation does not fire inside an unrelated word.
 */
function countTriggerHits(entry: MemoryEntry, queryCompact: string, queryTerms: Set<string>): number {
	let hits = 0;
	for (const trigger of entry.triggers ?? []) {
		const triggerTerms = lexicalTerms(trigger);
		if (triggerTerms.size === 0) continue;
		if (!/\p{Script=Han}/u.test(trigger)) {
			if ([...triggerTerms].every((term) => queryTerms.has(term))) hits++;
			continue;
		}
		const compact = compactForMatch(trigger);
		if (compact.length >= 2 && queryCompact.includes(compact)) {
			hits++;
			continue;
		}
		let overlap = 0;
		for (const term of triggerTerms) if (queryTerms.has(term)) overlap++;
		if (overlap >= Math.max(2, Math.ceil(triggerTerms.size / 2))) hits++;
	}
	return hits;
}

export interface MemorySelection {
	entry: MemoryEntry;
	/** Lexical relevance times the importance weight; 0 when only a trigger phrase matched. */
	score: number;
	via: "trigger" | "lexical";
	/** How many of the entry's trigger phrases the query matched. */
	triggerHits: number;
}

export interface MemorySelectionOptions {
	/** Keep at most this many results. Automatic recall keeps them all and is bounded by its byte budget instead. */
	limit?: number;
	/** Only consider memories of this scope. */
	scope?: MemoryScope;
}

/**
 * The one ranking used both by automatic recall and by the memory_search tool; it only reads its arguments.
 *
 * 1. Trigger route: entries whose trigger phrases match the query come first, most matches first, at most three,
 *    and are exempt from the relative-score cut of the second step.
 * 2. Lexical route: the existing TF-IDF relevance, multiplied by the importance weight (high 1.3, normal 1, low 0.7),
 *    keeping entries within half of the best weighted score.
 * 3. Entries with the same body are listed once. The resident profile is skipped here: it is sent every turn.
 */
export function selectMemoriesForQuery(
	query: string,
	entries: readonly MemoryEntry[],
	options: MemorySelectionOptions = {},
): MemorySelection[] {
	const pool = entries.filter((entry) => !isMemoryProfile(entry) && (!options.scope || entry.scope === options.scope));
	const queryTerms = lexicalTerms(query);
	const queryCompact = compactForMatch(query);
	const lexical = rankLexically(queryTerms, pool);
	const lexicalScores = new Map(lexical.map(({ entry, score }) => [entry, score]));
	const selected: MemorySelection[] = [];
	const seen = new Set<string>();
	const take = (selection: MemorySelection): boolean => {
		const key = memoryFingerprint(selection.entry);
		if (seen.has(key)) return false;
		seen.add(key);
		selected.push(selection);
		return true;
	};

	const direct = pool
		.map((entry) => ({ entry, hits: countTriggerHits(entry, queryCompact, queryTerms) }))
		.filter(({ hits }) => hits > 0)
		.sort(
			(a, b) =>
				b.hits - a.hits ||
				importanceWeight(b.entry) - importanceWeight(a.entry) ||
				b.entry.updatedAt.localeCompare(a.entry.updatedAt),
		);
	let directCount = 0;
	for (const { entry, hits } of direct) {
		if (directCount >= MAX_DIRECT_TRIGGER_MEMORIES) break;
		if (take({ entry, score: lexicalScores.get(entry) ?? 0, via: "trigger", triggerHits: hits })) directCount++;
	}

	const best = lexical[0]?.score ?? 0;
	for (const { entry, score } of lexical) {
		if (score < best * 0.5) continue;
		take({ entry, score, via: "lexical", triggerHits: 0 });
	}
	return options.limit === undefined ? selected : selected.slice(0, Math.max(0, options.limit));
}

function formatTranscript(entries: SessionEntry[], lastEntryId?: string): { text: string; lastEntryId?: string } {
	const startIndex = lastEntryId ? entries.findIndex((entry) => entry.id === lastEntryId) + 1 : 0;
	const candidates = entries.slice(Math.max(0, startIndex)).flatMap((entry) => {
		if (entry.type !== "message") return [];
		if (entry.message.role !== "user" && entry.message.role !== "assistant") return [];
		const text = contentText(entry.message.content, "\n").trim();
		if (!text) return [];
		return [{ id: entry.id, role: entry.message.role, text }];
	});
	if (candidates.length === 0) return { text: "", lastEntryId };

	// 输入不设上限：本轮新增聊天全文都送给提取器，不再按 24KB 截断。输出侧仍保留上限。
	const selected = candidates;
	return {
		text: selected.map((item) => `${item.role === "user" ? "User" : "Main AI"}:\n${item.text}`).join("\n\n"),
		lastEntryId: selected.at(-1)?.id,
	};
}

export class AutoMemoryManager {
	private readonly options: AutoMemoryManagerOptions;
	private initializedPaths?: AutoMemoryPaths;
	private maintenanceProcessing = false;
	private maintenanceTimer?: NodeJS.Timeout;
	private consolidationTimer?: NodeJS.Timeout;
	private maintenanceStatus: MemoryMaintenanceStatus = { phase: "idle" };
	private maintenanceEnqueue: Promise<void> = Promise.resolve();
	private readonly reportedErrors = new Set<string>();
	private backgroundQueue: Promise<void> = Promise.resolve();
	private readonly disposeController = new AbortController();
	private disposed = false;

	constructor(options: AutoMemoryManagerOptions) {
		this.options = options;
		if (options.persisted) {
			this.scheduleMaintenance();
			this.scheduleConsolidationCheck(1500);
		}
	}

	getMaintenanceStatus(): MemoryMaintenanceStatus {
		return { ...this.maintenanceStatus };
	}

	private setMaintenanceStatus(status: MemoryMaintenanceStatus): void {
		this.maintenanceStatus = status;
		try {
			this.options.onStatus?.(status);
		} catch {
			/* Observers cannot stop maintenance. */
		}
	}

	private get maintenancePath(): string {
		return path.join(this.paths.sessionDir, "maintenance.json");
	}

	/** Persist work before returning; model work is debounced and never awaited by the chat. */
	enqueueMaintenance(entries: SessionEntry[]): Promise<void> {
		if (!this.isEnabled() || this.disposed) return Promise.resolve();
		const snapshot = entries.flatMap((entry): SessionEntry[] => {
			if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant"))
				return [];
			let text: string;
			try {
				text = sanitizeMemoryText(contentText(entry.message.content, "\n"));
			} catch {
				text = "[Sensitive message omitted from memory maintenance]";
			}
			return [{ ...entry, message: { ...entry.message, content: [{ type: "text", text }] } }];
		});
		const queued = this.maintenanceEnqueue.then(async () => {
			this.assertActive();
			const cursor = readState(this.paths.statePath).sessions[this.options.sessionId]?.lastEntryId;
			const start = cursor ? snapshot.findIndex((entry) => entry.id === cursor) + 1 : 0;
			const delta = snapshot.slice(Math.max(0, start));
			if (delta.length === 0) return;
			await writeMemoryFile(
				this.maintenancePath,
				JSON.stringify({ version: 1, id: randomUUID(), entries: delta, attempts: 0 }),
			);
			this.setMaintenanceStatus({ phase: "pending" });
			this.scheduleMaintenance();
		});
		this.maintenanceEnqueue = queued.catch(() => undefined);
		return queued;
	}

	private scheduleMaintenance(delay = 1500): void {
		if (this.disposed) return;
		if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
		this.maintenanceTimer = setTimeout(() => {
			this.maintenanceTimer = undefined;
			void this.processMaintenance().catch((error) => {
				if (!this.disposed) this.setMaintenanceStatus({ phase: "warning", error: String(error).slice(0, 500) });
			});
		}, delay);
		this.maintenanceTimer.unref?.();
	}

	private async processMaintenance(): Promise<void> {
		if (this.disposed || !this.isEnabled()) return;
		if (this.maintenanceProcessing) {
			this.scheduleMaintenance();
			return;
		}
		this.maintenanceProcessing = true;
		try {
			await this.processMaintenanceJob();
		} finally {
			this.maintenanceProcessing = false;
		}
	}

	private async processMaintenanceJob(): Promise<void> {
		await this.maintenanceEnqueue;
		assertDirectPath(this.maintenancePath);
		if (!fs.existsSync(this.maintenancePath)) return;
		const job = JSON.parse(await fs.promises.readFile(this.maintenancePath, "utf8")) as MemoryMaintenanceJob;
		if (job.version !== 1 || !Array.isArray(job.entries) || typeof job.id !== "string")
			throw new Error("Invalid memory maintenance job");
		if (job.attempts >= 3) {
			this.setMaintenanceStatus({ phase: "warning", error: "Memory maintenance paused after repeated failures" });
			return;
		}
		this.setMaintenanceStatus({ phase: "processing" });
		const ok = await this.runExtraction(job.entries);
		if (this.disposed) return;
		// Serialize with enqueue so a completed old job cannot erase a newer snapshot.
		const settled = this.maintenanceEnqueue.then(async () => {
			this.assertActive();
			const current = JSON.parse(await fs.promises.readFile(this.maintenancePath, "utf8")) as MemoryMaintenanceJob;
			if (current.id !== job.id) {
				this.scheduleMaintenance();
				return;
			}
			if (ok) {
				const cursor = readState(this.paths.statePath).sessions[this.options.sessionId]?.lastEntryId;
				if (formatTranscript(job.entries, cursor).text) {
					this.scheduleMaintenance();
					return;
				}
				await fs.promises.unlink(this.maintenancePath);
				if (this.maintenanceStatus.phase !== "warning") this.setMaintenanceStatus({ phase: "idle" });
			} else {
				job.attempts++;
				await writeMemoryFile(this.maintenancePath, JSON.stringify(job));
				this.setMaintenanceStatus({
					phase: job.attempts >= 3 ? "warning" : "pending",
					error: job.attempts >= 3 ? "Memory maintenance failed; saved work will be retained" : undefined,
				});
				if (job.attempts < 3) this.scheduleMaintenance(30_000 * job.attempts);
			}
		});
		this.maintenanceEnqueue = settled.catch(() => undefined);
		await settled;
	}

	private scheduleConsolidationCheck(delay = 30_000): void {
		if (this.disposed) return;
		if (this.consolidationTimer) clearTimeout(this.consolidationTimer);
		this.consolidationTimer = setTimeout(() => {
			this.consolidationTimer = undefined;
			void this.runConsolidation().finally(() => this.scheduleConsolidationCheck());
		}, delay);
		this.consolidationTimer.unref?.();
	}

	/** Run saved due work, or explicitly review all memories visible to this conversation. */
	runConsolidation(force = false): Promise<boolean> {
		const settings = this.getSettings();
		if (this.disposed || !settings) return Promise.resolve(false);
		const result = this.backgroundQueue.then(async () => {
			try {
				await this.initializeConsolidationState();
				if (!force && !this.consolidationDue()) return true;
				this.setMaintenanceStatus({ phase: "processing" });
				await this.consolidate(settings);
				this.setMaintenanceStatus({ phase: "idle" });
				return true;
			} catch (error) {
				this.reportError("consolidate", error);
				if (!this.disposed) this.setMaintenanceStatus({ phase: "warning", error: String(error).slice(0, 500) });
				return false;
			}
		});
		this.backgroundQueue = result.then(() => undefined);
		return result;
	}

	private consolidationDue(): boolean {
		const value = readState(this.paths.statePath).consolidation[this.paths.workspaceId];
		return (
			!!value &&
			(value.pendingChanges ?? 0) > 0 &&
			((value.pendingChanges ?? 0) >= CONSOLIDATION_MIN_CHANGES ||
				Date.now() - Date.parse(value.pendingSince ?? "") >= CONSOLIDATION_INTERVAL_MS)
		);
	}

	private async initializeConsolidationState(): Promise<void> {
		await this.withLock(async () => {
			const state = readState(this.paths.statePath);
			const value = state.consolidation[this.paths.workspaceId] ?? { sessionIds: [] };
			if (value.pendingChanges !== undefined) return;
			// Older states counted conversations. Recover actual changed memories instead.
			const changed = this.loadEntries().filter((entry) => !value.lastAt || entry.updatedAt > value.lastAt);
			value.pendingChanges = changed.length;
			value.pendingSince = changed.map((entry) => entry.updatedAt).sort()[0];
			value.revision = 0;
			state.consolidation[this.paths.workspaceId] = value;
			await writeMemoryFile(this.paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
		});
	}

	/** Invalidate background work owned by a replaced AgentSession. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
		if (this.consolidationTimer) clearTimeout(this.consolidationTimer);
		this.disposeController.abort();
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Auto Memory task cancelled after session replacement");
	}

	private get paths(): AutoMemoryPaths {
		this.initializedPaths ??= getAutoMemoryPaths(this.options.cwd, this.options.agentDir, {
			dataRoot: this.options.dataRoot ?? getDataDir(),
			workspaceId: this.options.workspaceId ?? UNBOUND_WORKSPACE_ID,
			sessionId: this.options.sessionId,
		});
		return this.initializedPaths;
	}

	/** Whether Auto Memory is fully configured and active for this session. */
	isEnabled(): boolean {
		return this.getSettings() !== undefined;
	}

	private getSettings():
		| (AutoMemorySettings &
				Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">> & { enabled: true })
		| undefined {
		if (!this.options.persisted) return undefined;
		const settings = this.options.settingsManager.getAutoMemorySettings();
		if (!settings.enabled) return undefined;
		const resolved = resolveAssistantModel(settings, this.options.getMainModel?.());
		return resolved ? { enabled: true, ...resolved } : undefined;
	}

	private reportError(operation: "recall" | "extract" | "consolidate", error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		const key = `${operation}:${normalized.message}`;
		if (this.reportedErrors.has(key)) return;
		this.reportedErrors.add(key);
		try {
			this.options.onError?.(operation, normalized);
		} catch {
			// Error reporting is an observer. A UI/logging callback must not poison
			// the background memory queue or turn a handled failure into an
			// unhandled rejection.
		}
	}

	private async runModel(parameters: Parameters<AutoMemoryModelRunner>[0]): Promise<string> {
		this.assertActive();
		if (this.options.modelRunner) {
			const output = await this.options.modelRunner(parameters);
			this.assertActive();
			return output;
		}
		const runtime = this.options.modelRuntime;
		if (!runtime) {
			throw new Error("Auto Memory 缺少模型运行环境");
		}
		const model = runtime.getModel(parameters.settings.provider, parameters.settings.model);
		if (!model) {
			throw new Error(`Auto Memory 找不到已配置模型：${parameters.settings.provider}/${parameters.settings.model}`);
		}

		const abortController = new AbortController();
		const onDispose = () => abortController.abort();
		this.disposeController.signal.addEventListener("abort", onDispose, { once: true });
		const timeout = setTimeout(() => abortController.abort(), AUTO_MEMORY_TIMEOUT_MS);
		try {
			const retry = this.options.settingsManager.getProviderRetrySettings();
			const response = await runtime.completeSimple(
				model,
				{
					systemPrompt: parameters.systemPrompt,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: parameters.task }],
							timestamp: Date.now(),
						},
					],
				},
				{
					reasoning: parameters.settings.thinkingLevel === "off" ? undefined : parameters.settings.thinkingLevel,
					signal: abortController.signal,
					timeoutMs: sdkFirstByteTimeoutMs(model, this.options.settingsManager),
					maxRetries: retry.maxRetries,
					maxRetryDelayMs: retry.maxRetryDelayMs,
					maxTokens: 8192,
				},
			);
			this.assertActive();
			if (response.stopReason === "aborted") {
				throw new Error("Auto Memory 请求超时或被取消");
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "Auto Memory 模型请求失败");
			}
			const output = contentText(response.content, "\n").trim();
			if (!output) throw new Error("Auto Memory 模型没有返回内容");
			return output;
		} finally {
			clearTimeout(timeout);
			this.disposeController.signal.removeEventListener("abort", onDispose);
		}
	}

	private loadEntries(): MemoryEntry[] {
		return readMemoryEntries(this.paths);
	}

	async recall(query: string): Promise<CustomMessage | undefined> {
		if (this.disposed) return undefined;
		const settings = this.getSettings();
		if (!settings) return undefined;
		let candidates: MemoryEntry[];
		try {
			await migrateLegacyMemories(this.paths.dataRoot, this.options.agentDir);
			candidates = this.loadEntries();
		} catch (error) {
			this.reportError("recall", error);
			return undefined;
		}
		if (candidates.length === 0) return undefined;

		// Recall must never delay sending the user's message. The selected model is
		// still used for background extraction and consolidation; retrieval itself
		// is a bounded local operation that only reads. The resident user profile, when it exists, goes
		// first on every turn; the query only ranks the other memories.
		let selected: MemoryEntry[];
		try {
			const profile = candidates.find(isMemoryProfile);
			selected = [
				...(profile ? [profile] : []),
				...selectMemoriesForQuery(truncateUtf8(query, 12 * 1024), candidates).map(({ entry }) => entry),
			];
		} catch (error) {
			this.reportError("recall", error);
			return undefined;
		}
		if (selected.length === 0) return undefined;

		const sections: string[] = [];
		let turnBytes = Buffer.byteLength(MEMORY_CONTEXT_RULES, "utf8");
		for (const entry of selected) {
			const section = `## ${entry.name}\nType: ${entry.type}; Scope: ${entry.scope}\n${entry.content}`;
			const sectionBytes = Buffer.byteLength(section, "utf8");
			if (turnBytes + sectionBytes > RECALL_TURN_MAX_BYTES) {
				break;
			}
			sections.push(section);
			turnBytes += sectionBytes;
		}
		if (sections.length === 0) return undefined;

		return {
			role: "custom",
			customType: "auto-memory-recall",
			content: `${MEMORY_CONTEXT_RULES}\n\n<recalled_memory_context>\n${sections.join("\n\n")}\n</recalled_memory_context>`,
			display: false,
			details: { ids: selected.map((entry) => entry.id) },
			timestamp: Date.now(),
		};
	}

	scheduleExtraction(entries: SessionEntry[]): void {
		if (this.disposed) return;
		void this.runExtraction(entries).catch((error) => this.reportError("extract", error));
	}

	runExtraction(entries: SessionEntry[]): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		if (!this.options.persisted) return Promise.resolve(true);
		const settings = this.getSettings();
		if (!settings) {
			const configured = this.options.settingsManager.getAutoMemorySettings();
			if (configured.enabled) {
				this.reportError("extract", new Error("Auto Memory 模型或思考强度配置不完整，请在 /settings 中重新设置"));
				return Promise.resolve(false);
			}
			return Promise.resolve(true);
		}
		const snapshot = entries.slice();
		const result = this.backgroundQueue.then(async () => {
			if (this.disposed) return false;
			try {
				await this.extract(snapshot, settings);
				return true;
			} catch (error) {
				this.reportError("extract", error);
				return false;
			}
		});
		this.backgroundQueue = result.then(
			() => undefined,
			(error) => {
				this.reportError("extract", error);
			},
		);
		return result;
	}

	async waitForMaintenancePersistence(): Promise<void> {
		await this.maintenanceEnqueue;
	}

	async waitForBackgroundTasks(): Promise<void> {
		await this.backgroundQueue;
	}

	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		this.assertActive();
		return withMemoryLock(this.paths.dataRoot, async () => {
			this.assertActive();
			return fn();
		});
	}

	private async writeIndex(): Promise<void> {
		this.assertActive();
		await refreshMemoryIndexes(this.paths.dataRoot);
	}

	private async applyOperations(
		operations: MemoryOperation[],
		allowDelete: boolean,
		snapshot?: MemoryEntry[],
		sourceEntryId?: string,
	): Promise<void> {
		this.assertActive();
		await this.withLock(async () => {
			const existing = new Map(this.loadEntries().map((entry) => [entry.id, entry]));
			let changedCount = 0;
			if (snapshot) {
				if (existing.size !== snapshot.length)
					throw new Error("Memory changed during maintenance; retry with fresh context");
				for (const entry of snapshot) {
					if (
						existing.get(entry.id)?.updatedAt !== entry.updatedAt ||
						existing.get(entry.id)?.content !== entry.content
					)
						throw new Error("Memory changed during maintenance; retry with fresh context");
				}
			}
			for (const operation of operations.slice(0, 20)) {
				this.assertActive();
				if (operation.action === "delete") {
					if (!allowDelete) continue;
					if (!operation.id || !isSafeMemoryId(operation.id)) continue;
					const target = existing.get(operation.id);
					// The resident profile is rewritten by the consolidator, never retired by a model.
					if (!target || isMemoryProfile(target)) continue;
					await archiveMemoryFile(target.filePath, "consolidated");
					await fs.promises.unlink(target.filePath);
					existing.delete(operation.id);
					continue;
				}

				if (
					!operation.scope ||
					!MEMORY_SCOPES.has(operation.scope) ||
					!operation.type ||
					!MEMORY_TYPES.has(operation.type) ||
					typeof operation.name !== "string" ||
					typeof operation.description !== "string" ||
					typeof operation.content !== "string"
				) {
					continue;
				}
				const scope = operation.scope === "project" ? "workspace" : operation.scope;
				// Consolidation must not promote conversation information into a broader scope.
				if (allowDelete && (!operation.id || existing.get(operation.id)?.scope !== scope)) continue;
				if (operation.id && (!isSafeMemoryId(operation.id) || !operation.id.startsWith(`${scope}/`))) {
					continue;
				}
				let id =
					operation.id && isSafeMemoryId(operation.id) && operation.id.startsWith(`${scope}/`)
						? operation.id
						: `${scope}/${slugify(operation.name)}`;
				if (!existing.has(id) && !operation.id) {
					const base = id;
					let suffix = 2;
					while (existing.has(id)) id = `${base}-${suffix++}`;
				}
				// Only the consolidator maintains the resident profile; extraction must not stack turn-by-turn notes on it.
				if (!allowDelete && isMemoryProfile({ id, scope })) continue;
				const previous = existing.get(id);
				const now = new Date().toISOString();
				let name: string;
				let description: string;
				let content: string;
				try {
					name = truncateUtf8(sanitizeMemoryText(operation.name), 120);
					description = truncateUtf8(sanitizeMemoryText(operation.description), 300);
					content = truncateUtf8(sanitizeMemoryText(operation.content), MEMORY_BODY_MAX_BYTES);
				} catch {
					continue;
				}
				if (!name || !description || !content) continue;
				// An update that omits the annotations keeps the stored ones, including hand-written values; an empty
				// trigger list never clears them either.
				const importance = readImportance(operation.importance) ?? previous?.importance;
				const operationTriggers = normalizeTriggers(operation.triggers, sanitizeMemoryText);
				const triggers = operationTriggers.length > 0 ? operationTriggers : previous?.triggers;
				if (
					previous?.content === content &&
					previous.name === name &&
					previous.description === description &&
					previous.type === operation.type &&
					previous.importance === importance &&
					(previous.triggers ?? []).join("\n") === (triggers ?? []).join("\n")
				)
					continue;
				if (
					!previous &&
					[...existing.values()].some(
						(entry) =>
							entry.scope === scope &&
							entry.content.replace(/\s+/g, " ").trim() === content.replace(/\s+/g, " ").trim(),
					)
				)
					continue;
				const directory =
					scope === "global"
						? this.paths.globalDir
						: scope === "session"
							? this.paths.sessionDir
							: this.paths.projectDir;
				const filePath = path.join(directory, `${id.slice(scope.length + 1)}.md`);
				const entry: MemoryEntry = {
					id,
					name,
					description,
					type: operation.type,
					scope,
					content,
					createdAt: previous?.createdAt ?? now,
					updatedAt: now,
					filePath,
					importance,
					triggers,
					workspaceId: scope === "global" ? undefined : this.paths.workspaceId,
					sessionId: scope === "session" ? this.paths.sessionId : undefined,
					sourceEntryId: sourceEntryId ?? previous?.sourceEntryId,
					sourceWorkspaceId: sourceEntryId ? this.paths.workspaceId : previous?.sourceWorkspaceId,
					sourceSessionId: sourceEntryId ? this.paths.sessionId : previous?.sourceSessionId,
				};
				this.assertActive();
				if (previous) await archiveMemoryFile(previous.filePath, "updated");
				await writeMemoryFile(filePath, serializeMemory(entry));
				if (previous && previous.filePath !== filePath) await fs.promises.unlink(previous.filePath);
				existing.set(id, entry);
				changedCount++;
			}
			if (!allowDelete && changedCount > 0) {
				const state = readState(this.paths.statePath);
				const value = state.consolidation[this.paths.workspaceId] ?? { sessionIds: [] };
				value.pendingChanges = (value.pendingChanges ?? 0) + changedCount;
				value.pendingSince ??= new Date().toISOString();
				value.revision = (value.revision ?? 0) + 1;
				state.consolidation[this.paths.workspaceId] = value;
				await writeMemoryFile(this.paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
			}
			await this.writeIndex();
		});
	}

	private async updateState(lastEntryId: string): Promise<{ shouldConsolidate: boolean }> {
		this.assertActive();
		return this.withLock(async () => {
			const state = readState(this.paths.statePath);
			const now = new Date();
			state.sessions[this.options.sessionId] = { lastEntryId, updatedAt: now.toISOString() };
			const sessionEntries = Object.entries(state.sessions).sort((a, b) =>
				b[1].updatedAt.localeCompare(a[1].updatedAt),
			);
			state.sessions = Object.fromEntries(sessionEntries);
			const consolidation = state.consolidation[this.paths.workspaceId] ?? { sessionIds: [] };
			state.consolidation[this.paths.workspaceId] = consolidation;
			if (!consolidation.sessionIds.includes(this.options.sessionId)) {
				consolidation.sessionIds.push(this.options.sessionId);
			}
			const shouldConsolidate =
				(consolidation.pendingChanges ?? 0) > 0 &&
				((consolidation.pendingChanges ?? 0) >= CONSOLIDATION_MIN_CHANGES ||
					Date.now() - Date.parse(consolidation.pendingSince ?? "") >= CONSOLIDATION_INTERVAL_MS);
			this.assertActive();
			await writeMemoryFile(this.paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
			return { shouldConsolidate };
		});
	}

	private async extract(
		entries: SessionEntry[],
		settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>,
	): Promise<void> {
		this.assertActive();
		await migrateLegacyMemories(this.paths.dataRoot, this.options.agentDir);
		await this.initializeConsolidationState();
		const state = readState(this.paths.statePath);
		const cursor = state.sessions[this.options.sessionId]?.lastEntryId;
		const transcript = formatTranscript(entries, cursor);
		if (!transcript.text || !transcript.lastEntryId) return;
		const existing = this.loadEntries();
		const output = await this.runModel({
			cwd: this.options.cwd,
			settings,
			systemPrompt: MEMORY_EXTRACTOR_PROMPT,
			task: [
				`Current project root: ${this.paths.projectRoot}\nWorkspace ID: ${this.paths.workspaceId}\nSession ID: ${this.paths.sessionId}\nResident user profile entry ID (never create or modify it): ${MEMORY_PROFILE_ID}`,
				`Existing memory list:\n${formatManifest(existing)}`,
				`New conversation since last extraction:\n${transcript.text}`,
			].join("\n\n"),
		});
		this.assertActive();
		const operations = parseMemoryOperations(output);
		if (operations === undefined) throw new Error("Auto Memory 返回了无效的操作格式");
		await this.applyOperations(operations.slice(0, 12), false, existing, transcript.lastEntryId);
		this.assertActive();
		const { shouldConsolidate } = await this.updateState(transcript.lastEntryId);
		if (shouldConsolidate) {
			try {
				await this.consolidate(settings);
			} catch (error) {
				this.reportError("consolidate", error);
				this.setMaintenanceStatus({ phase: "warning", error: String(error).slice(0, 500) });
			}
		}
	}

	private async consolidate(
		settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>,
	): Promise<void> {
		this.assertActive();
		const revision = readState(this.paths.statePath).consolidation[this.paths.workspaceId]?.revision ?? 0;
		const entries = this.loadEntries();
		// 输入不设上限：整理时一批处理全部可见记忆，不再按 60KB 切分多批。
		const batches: MemoryEntry[][] = [[]];
		const format = (entry: MemoryEntry) =>
			`ID: ${entry.id}\nScope: ${entry.scope}\nName: ${entry.name}\nDescription: ${entry.description}\nType: ${entry.type}${entry.importance ? `\nImportance: ${entry.importance}` : ""}${entry.triggers?.length ? `\nTriggers: ${JSON.stringify(entry.triggers)}` : ""}\nContent:\n${entry.content}`;
		for (const entry of entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
			batches.at(-1)!.push(entry);
		}
		for (const batch of batches) {
			if (batch.length === 0) continue;
			const snapshot = this.loadEntries();
			const output = await this.runModel({
				cwd: this.options.cwd,
				settings,
				systemPrompt: MEMORY_CONSOLIDATOR_PROMPT,
				task: `Resident user profile entry ID (maintain it only if it is listed below): ${MEMORY_PROFILE_ID}\n\nPlease consolidate the following existing memories:\n\n${batch.map(format).join("\n\n---\n\n")}`,
			});
			this.assertActive();
			const operations = parseMemoryOperations(output);
			if (operations === undefined) throw new Error("Auto Memory 整理器返回了无效的操作格式");
			const ids = new Set(batch.map((entry) => entry.id));
			await this.applyOperations(
				operations.filter((operation) => !!operation.id && ids.has(operation.id)),
				true,
				snapshot,
			);
		}
		await this.withLock(async () => {
			const state = readState(this.paths.statePath);
			const value = state.consolidation[this.paths.workspaceId];
			if (value && (value.revision ?? 0) === revision) {
				value.lastAt = new Date().toISOString();
				value.sessionIds = [];
				value.pendingChanges = 0;
				value.pendingSince = undefined;
				await writeMemoryFile(this.paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
			}
		});
	}
}
