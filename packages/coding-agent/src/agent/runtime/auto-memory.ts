import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { contentText } from "@myharness/ai";
import { stringify as stringifyYaml } from "yaml";
import {
	getDataDir,
	getSessionDir,
	getWorkspaceDir,
	getWorkspacesDir,
	UNBOUND_WORKSPACE_ID,
} from "../../config/paths/index.ts";
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

// 10KB 只算正文（标题摘要等头不计），常驻画像整篇也按这个来；普通条目仍要求写短。
export const MEMORY_BODY_MAX_BYTES = 10 * 1024;
const MEMORY_TRIGGER_MAX_COUNT = 6;
const MEMORY_TRIGGER_MAX_BYTES = 60;
const MAX_DIRECT_TRIGGER_MEMORIES = 3;
const MEMORY_IMPORTANCE_WEIGHT: Record<MemoryImportance, number> = { high: 1.3, normal: 1, low: 0.7 };
const MEMORY_IMPORTANCES = new Set<MemoryImportance>(["high", "normal", "low"]);
/** The one global entry the consolidator maintains; it is sent with every turn instead of being ranked. */
export const MEMORY_PROFILE_ID = "global/用户画像";
/**
 * Recall-side token estimate tuned for Chinese text: every non-ASCII character counts as ~1 token,
 * ASCII characters count as ~1 token per 4 characters (rounded up). The shared estimateTextTokens
 * (utf8 bytes / 4) undercounts Chinese by ~3x, which used to starve the directory budget.
 */
export function estimateMemoryTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const character of text) {
		if ((character.codePointAt(0) ?? 0) <= 127) ascii++;
		else nonAscii++;
	}
	return nonAscii + Math.ceil(ascii / 4);
}

/** Cut a one-line directory summary to 16-24 characters: keep short ones whole, shorten long ones with an ellipsis. */
function shortenDirectoryDescription(value: string): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	const points = [...oneLine];
	if (points.length <= 24) return oneLine;
	return `${points.slice(0, 20).join("").trimEnd()}…`;
}

/** Shrink text to a token budget measured by estimateMemoryTokens. */
function truncateToTokenBudget(value: string, maxTokens: number): string {
	const normalized = value.trim();
	if (estimateMemoryTokens(normalized) <= maxTokens) return normalized;
	let low = 0;
	let high = normalized.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (estimateMemoryTokens(normalized.slice(0, mid)) <= maxTokens) low = mid + 1;
		else high = mid;
	}
	return normalized.slice(0, Math.max(0, low - 1)).trimEnd();
}

// 召回分层 token 预算（estimateMemoryTokens 新口径：非 ASCII 字符约 1 token、ASCII 约 1/4 token）：画像固定位 + 目录位 + 动态卡片位。
// 实测：目录行约 30 token/条，120 条约 3615，130 条约 3917；10KB 全中文画像约 3425，典型画像约 600，典型卡片约 300。
// 目录位 4200 覆盖约 130 条（当前量级 100-130 条尽量列全）；画像位 3500 覆盖 10KB 上限的最坏情况（仅截断帽、非实际花费）；
// 总量 8000 与旧口径 6000 的实际花费大致相当（旧口径低估中文约 3 倍）；规矩头不占额度。
const RECALL_TOTAL_TOKEN_BUDGET = 8000;
const RECALL_PROFILE_TOKEN_RESERVE = 3500;
const RECALL_DIRECTORY_TOKEN_BUDGET = 4200;
// 稳定性切块：提取按 30 条聊天一切逐块推进、整理按 20 张记忆一批独立存，
// 单次模型输出仍受 maxTokens 限制、单条记忆正文 10KB 只算正文。主聊天的召回按分层 token 预算发送（画像固定位＋目录位＋动态卡片位），不在此列。
const EXTRACT_CHUNK_ENTRIES = 30;
const CONSOLIDATION_BATCH_SIZE = 20;
// 词面排序保证的最低条数：阈值之外的最佳匹配也至少带这么多，保证“找得到”。
// 用户拍板：保底 8 条（上下文开销最大一档）。触发词直达（最多 3 条）不计入此数。
const MEMORY_SELECTION_GUARANTEED = 8;
// 候选矛盾对上限：整理时喂给整理器的本地启发式候选，最多列这么多对，由模型核实。
const MEMORY_CONTRADICTION_PAIR_LIMIT = 10;
const CONSOLIDATION_MIN_CHANGES = 5;
const CONSOLIDATION_INTERVAL_MS = 3 * 60 * 60 * 1000;
// 按工作区串行的整理互斥：同一工作区同时只允许一个整理任务在跑（跨会话实例共享）。
// 后来者本轮直接跳过，由 30 秒后的下一轮定时器自然排队，而不是跑完再撞快照冲突。
const activeConsolidations = new Set<string>();
const AUTO_MEMORY_TIMEOUT_MS = 15 * 60 * 1000;
export const MEMORY_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
export const MEMORY_SCOPES = new Set<MemoryScope>(["global", "workspace", "session", "project"]);

// 记忆维护本地日志：只追加、不改业务，排查“记忆维护需要检查”用。
// 落盘位置：<data>/workspaces/<workspaceId>/sessions/<sessionId>/memory/maintenance.log（JSONL，一行一条）。
const MAINTENANCE_LOG_FILE = "maintenance.log";
const MAINTENANCE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAINTENANCE_LOG_PREVIEW_CHARS = 2000;

function truncateLogPreview(value: string, maxChars = MAINTENANCE_LOG_PREVIEW_CHARS): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

function describeMaintenanceError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		const withStatus = error as Error & { status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
		return {
			errorName: error.name,
			errorMessage: error.message,
			errorStack: error.stack ?? String(error),
			...(withStatus.code !== undefined ? { errorCode: String(withStatus.code) } : {}),
			...(withStatus.status !== undefined ? { httpStatus: String(withStatus.status) } : {}),
			...(withStatus.statusCode !== undefined ? { httpStatusCode: String(withStatus.statusCode) } : {}),
			...(withStatus.cause instanceof Error
				? { causeMessage: withStatus.cause.message, causeStack: withStatus.cause.stack }
				: withStatus.cause !== undefined
					? { causeMessage: String(withStatus.cause) }
					: {}),
		};
	}
	return { errorName: typeof error, errorMessage: String(error), errorStack: String(error) };
}

export function getAutoMemoryMaintenanceLogPath(sessionDir: string): string {
	return path.join(sessionDir, MAINTENANCE_LOG_FILE);
}

function appendMaintenanceLogLine(logPath: string, entry: Record<string, unknown>): void {
	try {
		assertDirectPath(logPath);
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		try {
			const stat = fs.statSync(logPath);
			if (stat.size > MAINTENANCE_LOG_MAX_BYTES) {
				const rotated = `${logPath}.1`;
				try {
					if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
				} catch {
					// 轮转清理失败不挡本次写入。
				}
				try {
					fs.renameSync(logPath, rotated);
				} catch {
					// 轮转失败就继续往原文件追加，避免丢掉本次现场。
				}
			}
		} catch {
			// 新文件没有 stat 很正常，直接追加即可。
		}
		fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// 日志本身永远不能打断记忆维护。
	}
}

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

export function slugify(value: string): string {
	const slug = value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || `memory-${randomUUID().slice(0, 8)}`;
}

export function isSafeMemoryId(id: string): boolean {
	// pending/ 是待认领隔离区的 id 前缀：可被查看、认领与彻底删除，但模型整理/抽取不能以它建新记忆。
	return /^(global|workspace|session|project|pending)\/[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(id);
}

export function readImportance(value: unknown): MemoryImportance | undefined {
	return typeof value === "string" && MEMORY_IMPORTANCES.has(value as MemoryImportance)
		? (value as MemoryImportance)
		: undefined;
}

/**
 * Trigger phrases from a frontmatter value or a model operation: collapse whitespace, cut each to the byte limit,
 * drop empty or repeated ones and keep the first six. Oversized input is trimmed, never rejected.
 */
export function normalizeTriggers(value: unknown, clean: (text: string) => string = (text) => text): string[] {
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

export function serializeMemory(entry: MemoryEntry): string {
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
				const parsed = JSON.parse(candidate) as unknown;
				// 兼容裸数组：模型可能直接返回 [...] 而不是 {"operations":[...]}。
				const parsedOperations = Array.isArray(parsed) ? parsed : (parsed as { operations?: unknown }).operations;
				if (!Array.isArray(parsedOperations)) continue;
				return parsedOperations.filter((value): value is MemoryOperation => {
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
	/** Keep at most this many results. Automatic recall keeps them all and is bounded by its token budget instead. */
	limit?: number;
	/** Only consider memories of this scope. */
	scope?: MemoryScope;
	/**
	 * How many lexical matches to guarantee even below the relative-score cut. Defaults to 8 per user decision
	 * (trigger-route hits do not count toward it). Set 0 to restore the strict cut-only behavior.
	 */
	guaranteed?: number;
}

/**
 * The one ranking used both by automatic recall and by the memory_search tool; it only reads its arguments.
 *
 * 1. Trigger route: entries whose trigger phrases match the query come first, most matches first, at most three,
 *    and are exempt from the relative-score cut of the second step.
 * 2. Lexical route: the existing TF-IDF relevance, multiplied by the importance weight (high 1.3, normal 1, low 0.7),
 *    keeping entries within half of the best weighted score.
 * 3. Guarantee: the best lexical matches below the cut are still kept until `guaranteed` (default 8) lexical
 *    entries are selected, so a paraphrased query still finds something. Only ranked (score > 0) entries qualify.
 * 4. Entries with the same body are listed once. The resident profile is skipped here: it is sent every turn.
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

	// 保底：阈值之外的最佳词面匹配也保留，直到词面条数达到 guaranteed。只收有得分的，不凭空凑数。
	const guaranteed = options.guaranteed ?? MEMORY_SELECTION_GUARANTEED;
	if (guaranteed > 0) {
		let lexicalCount = selected.filter((selection) => selection.via === "lexical").length;
		if (lexicalCount < guaranteed) {
			for (const { entry, score } of lexical) {
				if (lexicalCount >= guaranteed) break;
				if (take({ entry, score, via: "lexical", triggerHits: 0 })) lexicalCount++;
			}
		}
	}
	return options.limit === undefined ? selected : selected.slice(0, Math.max(0, options.limit));
}

export interface MemoryContradiction {
	/** The older entry (by updatedAt). */
	a: MemoryEntry;
	/** The newer entry (by updatedAt). */
	b: MemoryEntry;
	/** Rare terms both entries share: why they look like the same topic. */
	sharedTerms: string[];
	/** Sum of idf weights of the shared rare terms. */
	score: number;
	/** Temporal/corrective cue words found in either body (不再/改为/之前/…). */
	cues: string[];
}

const CONTRADICTION_CUES = [
	"不再",
	"改为",
	"之前",
	"现在",
	"纠正",
	"不要",
	"禁止",
	"必须",
	"取代",
	"替代",
	"过期",
	"作废",
];

/**
 * Read-only heuristic for “two memories that may contradict each other”.
 *
 * Pairs share at least two rare terms (document frequency at most a quarter of the pool) and are ordered with
 * corrective-cue pairs first. This only nominates candidates: the consolidator model verifies them, because only
 * it can tell a real contradiction from two memories about the same topic. Pure function, reads nothing, writes nothing.
 */
export function findMemoryContradictions(
	entries: readonly MemoryEntry[],
	limit: number = MEMORY_CONTRADICTION_PAIR_LIMIT,
): MemoryContradiction[] {
	if (entries.length < 2 || limit <= 0) return [];
	const pool = [...entries];
	const termSets = pool.map((entry) => lexicalTerms(`${entry.name}\n${entry.description}\n${entry.content}`));
	const documentFrequency = new Map<string, number>();
	for (const terms of termSets)
		for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
	const rareEnough = (term: string): boolean => (documentFrequency.get(term) ?? 0) <= Math.max(2, pool.length / 4);
	const idf = (term: string): number => Math.log(1 + pool.length / (documentFrequency.get(term) ?? 1));
	const pairs: MemoryContradiction[] = [];
	for (let i = 0; i < pool.length; i++) {
		for (let j = i + 1; j < pool.length; j++) {
			const shared = [...termSets[i]].filter((term) => termSets[j].has(term) && rareEnough(term));
			if (shared.length < 2) continue;
			const [a, b] =
				pool[i].updatedAt.localeCompare(pool[j].updatedAt) <= 0 ? [pool[i], pool[j]] : [pool[j], pool[i]];
			const cues = CONTRADICTION_CUES.filter((cue) => a.content.includes(cue) || b.content.includes(cue));
			pairs.push({
				a,
				b,
				sharedTerms: shared.sort().slice(0, 8),
				score: shared.reduce((sum, term) => sum + idf(term), 0),
				cues,
			});
		}
	}
	return pairs.sort((x, y) => y.cues.length - x.cues.length || y.score - x.score).slice(0, Math.max(0, limit));
}

/**
 * A memory that lives outside the current conversation's own three layers: another workspace's
 * workspace/session memories, or a quarantined pending memory waiting to be claimed.
 * Read-only views: automatic recall never injects these; they surface through the memory_search
 * directory/summaries and are fetched in full with memory_get on demand.
 */
export interface CrossScopeMemoryEntry {
	kind: "foreign" | "pending";
	id: string;
	name: string;
	description: string;
	type: MemoryType;
	scope: MemoryScope | "pending";
	content: string;
	createdAt: string;
	updatedAt: string;
	importance?: MemoryImportance;
	triggers?: string[];
	workspaceId?: string;
	sessionId?: string;
	/** e.g. “跨项目 · 工作区 ws-1” / “跨项目 · 工作区 ws-1 · 对话 s-2” / “待认领”. */
	originLabel: string;
	/** Absolute file path backing this entry (used by claim/delete flows). */
	sourcePath: string;
}

function toCrossScopeEntry(
	entry: MemoryEntry,
	kind: "foreign" | "pending",
	originLabel: string,
): CrossScopeMemoryEntry {
	return { ...entry, kind, originLabel, sourcePath: entry.filePath };
}

/** Lenient reader for quarantined pending files: an id is required, everything else falls back. */
function parsePendingMemoryFile(filePath: string): CrossScopeMemoryEntry | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = parseFrontmatter<Record<string, unknown>>(raw);
		const id = typeof parsed.frontmatter.id === "string" ? parsed.frontmatter.id : "";
		if (!id.startsWith("pending/") || !isSafeMemoryId(id)) return undefined;
		const name =
			typeof parsed.frontmatter.name === "string" && parsed.frontmatter.name.trim()
				? parsed.frontmatter.name.trim()
				: path.basename(filePath, ".md");
		const description =
			typeof parsed.frontmatter.description === "string" && parsed.frontmatter.description.trim()
				? parsed.frontmatter.description.trim()
				: `${name} 相关时`;
		const type =
			typeof parsed.frontmatter.type === "string" && MEMORY_TYPES.has(parsed.frontmatter.type as MemoryType)
				? (parsed.frontmatter.type as MemoryType)
				: "reference";
		const triggers = normalizeTriggers(parsed.frontmatter.triggers);
		return {
			kind: "pending",
			id,
			name,
			description,
			type,
			scope: "pending",
			content: truncateUtf8(parsed.body, MEMORY_BODY_MAX_BYTES),
			createdAt:
				typeof parsed.frontmatter.createdAt === "string" ? parsed.frontmatter.createdAt : new Date(0).toISOString(),
			updatedAt:
				typeof parsed.frontmatter.updatedAt === "string" ? parsed.frontmatter.updatedAt : new Date(0).toISOString(),
			importance: readImportance(parsed.frontmatter.importance),
			triggers: triggers.length > 0 ? triggers : undefined,
			originLabel: "待认领",
			sourcePath: filePath,
		};
	} catch {
		return undefined;
	}
}

function childDirectories(directory: string): string[] {
	assertDirectPath(directory);
	if (!fs.existsSync(directory)) return [];
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.filter((item) => item.isDirectory() && !item.isSymbolicLink())
		.map((item) => item.name);
}

/**
 * Read memories outside the current conversation's own layers, newest first. Read-only: archive/ is skipped,
 * nothing is written, and automatic recall never consumes the result. Pending quarantine entries are included
 * so they can be inspected and claimed instead of rotting unseen.
 */
export function readCrossScopeMemoryEntries(
	dataRoot: string,
	location: { workspaceId: string; sessionId: string },
): CrossScopeMemoryEntry[] {
	const result: CrossScopeMemoryEntry[] = [];
	const resolvedRoot = path.resolve(dataRoot);
	for (const workspaceId of childDirectories(getWorkspacesDir(resolvedRoot))) {
		if (workspaceId === location.workspaceId) continue;
		const workspaceMemory = path.join(getWorkspaceDir(resolvedRoot, workspaceId), "memory");
		for (const entry of scanMemoryDirectory(workspaceMemory, "workspace")) {
			result.push(toCrossScopeEntry(entry, "foreign", `跨项目 · 工作区 ${workspaceId}`));
		}
		const sessionsDir = path.join(getWorkspaceDir(resolvedRoot, workspaceId), "sessions");
		for (const sessionId of childDirectories(sessionsDir)) {
			const sessionMemory = path.join(getSessionDir(resolvedRoot, workspaceId, sessionId), "memory");
			for (const entry of scanMemoryDirectory(sessionMemory, "session")) {
				result.push(toCrossScopeEntry(entry, "foreign", `跨项目 · 工作区 ${workspaceId} · 对话 ${sessionId}`));
			}
		}
	}
	// Own workspace's sibling conversations stay private to automatic recall, but their titles are visible
	// on demand so nothing learned in another chat is silently lost. Controlled by user decision.
	const ownSessionsDir = path.join(getWorkspaceDir(resolvedRoot, location.workspaceId), "sessions");
	for (const sessionId of childDirectories(ownSessionsDir)) {
		if (sessionId === location.sessionId) continue;
		const sessionMemory = path.join(getSessionDir(resolvedRoot, location.workspaceId, sessionId), "memory");
		for (const entry of scanMemoryDirectory(sessionMemory, "session")) {
			result.push(toCrossScopeEntry(entry, "foreign", `同工作区 · 对话 ${sessionId}`));
		}
	}
	const pendingRoot = path.join(resolvedRoot, "memory", "pending");
	for (const key of childDirectories(pendingRoot)) {
		const directory = path.join(pendingRoot, key);
		assertDirectPath(directory);
		for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
			if (!item.isFile() || !item.name.endsWith(".md")) continue;
			const file = path.join(directory, item.name);
			assertDirectPath(file);
			const entry = parsePendingMemoryFile(file);
			if (entry) result.push(entry);
		}
	}
	return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
	/** 连续整理失败轮数：成功（含 noop）即清零；连续 3 轮才亮黄灯（降噪），灯上带最近失败原因。 */
	private consolidationFailureStreak = 0;
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

	/** Retry a paused maintenance job: reset its attempts and run it again soon. Returns false when there is no job to retry. */
	async retryMaintenance(): Promise<boolean> {
		if (this.disposed) return false;
		if (!fs.existsSync(this.maintenancePath)) {
			this.logMaintenance("retry-noop", { reason: "no maintenance.json" });
			this.setMaintenanceStatus({ phase: "idle" });
			return false;
		}
		try {
			const job = JSON.parse(await fs.promises.readFile(this.maintenancePath, "utf8")) as MemoryMaintenanceJob;
			if (job.version !== 1 || !Array.isArray(job.entries) || typeof job.id !== "string")
				throw new Error("Invalid memory maintenance job");
			job.attempts = 0;
			await writeMemoryFile(this.maintenancePath, JSON.stringify(job));
			this.logMaintenance("retry", { jobId: job.id, entriesCount: job.entries.length, attemptsResetTo: 0 });
			this.setMaintenanceStatus({ phase: "pending" });
			this.scheduleMaintenance();
			return true;
		} catch (error) {
			this.logMaintenance("retry-error", { ...describeMaintenanceError(error) });
			throw error;
		}
	}

	/** Dismiss a stuck job: move it into the session archive and go idle. Nothing is permanently deleted. Returns the archive file name, or null when there was no job. */
	async dismissMaintenance(): Promise<string | null> {
		if (!fs.existsSync(this.maintenancePath)) {
			this.logMaintenance("dismiss-noop", { reason: "no maintenance.json" });
			this.setMaintenanceStatus({ phase: "idle" });
			return null;
		}
		try {
			const archiveDir = path.join(this.paths.sessionDir, "archive");
			assertDirectPath(archiveDir);
			await fs.promises.mkdir(archiveDir, { recursive: true });
			const name = `maintenance-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
			const target = path.join(archiveDir, name);
			assertDirectPath(target);
			await fs.promises.rename(this.maintenancePath, target);
			this.logMaintenance("dismiss", { archivedFile: name });
			this.setMaintenanceStatus({ phase: "idle" });
			return name;
		} catch (error) {
			this.logMaintenance("dismiss-error", { ...describeMaintenanceError(error) });
			throw error;
		}
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

	private get maintenanceLogPath(): string {
		return getAutoMemoryMaintenanceLogPath(this.paths.sessionDir);
	}

	/** 本地结构化日志：只追加写 maintenance.log，失败静默，绝不抛错。 */
	private logMaintenance(stage: string, details: Record<string, unknown> = {}): void {
		try {
			appendMaintenanceLogLine(this.maintenanceLogPath, {
				ts: new Date().toISOString(),
				sessionId: this.options.sessionId,
				workspaceId: this.paths.workspaceId,
				stage,
				...details,
			});
		} catch {
			// 日志失败不影响主流程。
		}
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
			try {
				this.assertActive();
				const cursor = readState(this.paths.statePath).sessions[this.options.sessionId]?.lastEntryId;
				const start = cursor ? snapshot.findIndex((entry) => entry.id === cursor) + 1 : 0;
				const delta = snapshot.slice(Math.max(0, start));
				if (delta.length === 0) {
					this.logMaintenance("enqueue-noop", { snapshotCount: snapshot.length, cursor });
					return;
				}
				const jobId = randomUUID();
				await writeMemoryFile(
					this.maintenancePath,
					JSON.stringify({ version: 1, id: jobId, entries: delta, attempts: 0 }),
				);
				this.logMaintenance("enqueue", { jobId, deltaCount: delta.length, snapshotCount: snapshot.length, cursor });
				this.setMaintenanceStatus({ phase: "pending" });
				this.scheduleMaintenance();
			} catch (error) {
				this.logMaintenance("enqueue-error", {
					snapshotCount: snapshot.length,
					...describeMaintenanceError(error),
				});
				throw error;
			}
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
				this.logMaintenance("maintenance-timer-error", { ...describeMaintenanceError(error) });
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
		if (!fs.existsSync(this.maintenancePath)) {
			this.logMaintenance("maintenance-noop", { reason: "no maintenance.json" });
			return;
		}
		let job: MemoryMaintenanceJob;
		try {
			job = JSON.parse(await fs.promises.readFile(this.maintenancePath, "utf8")) as MemoryMaintenanceJob;
		} catch (error) {
			this.logMaintenance("maintenance-read-error", { ...describeMaintenanceError(error) });
			throw error;
		}
		if (job.version !== 1 || !Array.isArray(job.entries) || typeof job.id !== "string") {
			this.logMaintenance("maintenance-invalid-job", { jobId: (job as { id?: unknown }).id });
			throw new Error("Invalid memory maintenance job");
		}
		if (job.attempts >= 3) {
			this.logMaintenance("maintenance-paused", {
				jobId: job.id,
				attempts: job.attempts,
				entriesCount: job.entries.length,
			});
			this.setMaintenanceStatus({ phase: "warning", error: "Memory maintenance paused after repeated failures" });
			return;
		}
		this.logMaintenance("maintenance-start", {
			jobId: job.id,
			attempts: job.attempts,
			entriesCount: job.entries.length,
		});
		this.setMaintenanceStatus({ phase: "processing" });
		const ok = await this.runExtraction(job.entries);
		if (this.disposed) return;
		// Serialize with enqueue so a completed old job cannot erase a newer snapshot.
		const settled = this.maintenanceEnqueue.then(async () => {
			this.assertActive();
			const current = JSON.parse(await fs.promises.readFile(this.maintenancePath, "utf8")) as MemoryMaintenanceJob;
			if (current.id !== job.id) {
				this.logMaintenance("maintenance-superseded", { jobId: job.id, currentJobId: current.id });
				this.scheduleMaintenance();
				return;
			}
			if (ok) {
				const cursor = readState(this.paths.statePath).sessions[this.options.sessionId]?.lastEntryId;
				if (formatTranscript(job.entries, cursor).text) {
					this.logMaintenance("maintenance-reschedule", { jobId: job.id, reason: "new entries arrived" });
					this.scheduleMaintenance();
					return;
				}
				await fs.promises.unlink(this.maintenancePath);
				this.logMaintenance("maintenance-done", { jobId: job.id, result: "ok" });
				if (this.maintenanceStatus.phase !== "warning") this.setMaintenanceStatus({ phase: "idle" });
			} else {
				job.attempts++;
				await writeMemoryFile(this.maintenancePath, JSON.stringify(job));
				this.logMaintenance("maintenance-done", {
					jobId: job.id,
					result: "failed",
					attempts: job.attempts,
					nextDelayMs: job.attempts < 3 ? 30_000 * job.attempts : 0,
				});
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

	/** Run saved due work, or explicitly review all memories visible to this conversation.
	 * 软件开着时，任一存活聊天还会顺带清扫其他到期工作区（含 unbound），不为此新建 runtime。 */
	runConsolidation(force = false): Promise<boolean> {
		const settings = this.getSettings();
		if (this.disposed || !settings) return Promise.resolve(false);
		const result = this.backgroundQueue.then(async () => {
			try {
				await this.initializeConsolidationState();
				const ownDue = force || this.consolidationDue();
				// 软件开着时，有任意聊天存活就顺带清扫其他到期工作区；未点开聊天的会话私密笔记仍等本人点开。
				const othersDue = !force && this.listSweepWorkspaceIds().some((id) => this.consolidationDueFor(id));
				if (!ownDue && !othersDue) {
					this.logMaintenance("consolidation-noop", { force });
					this.noteConsolidationSuccess();
					return true;
				}
				this.logMaintenance("consolidation-start", { force, ownDue, othersDue });
				this.setMaintenanceStatus({ phase: "processing" });
				if (ownDue) await this.consolidate(settings);
				if (!force) await this.sweepDueWorkspaces(settings);
				this.logMaintenance("consolidation-done", { force, result: "ok" });
				this.noteConsolidationSuccess();
				this.setMaintenanceStatus({ phase: "idle" });
				return true;
			} catch (error) {
				this.logMaintenance("consolidation-done", { force, result: "failed", ...describeMaintenanceError(error) });
				// 会话替换导致的中止：静默退出，不计失败、不报错、不亮灯。
				if (this.disposed) return false;
				this.reportError("consolidate", error);
				// 黄灯降噪：瞬时失败静默退避，连续 3 轮仍失败才亮灯，且灯上带最近失败原因。
				this.noteConsolidationFailure(error);
				return false;
			}
		});
		this.backgroundQueue = result.then(() => undefined);
		return result;
	}

	private consolidationDue(): boolean {
		return this.consolidationDueFor(this.paths.workspaceId);
	}

	private consolidationDueFor(workspaceId: string): boolean {
		const value = readState(this.paths.statePath).consolidation[workspaceId];
		return (
			!!value &&
			(value.pendingChanges ?? 0) > 0 &&
			((value.pendingChanges ?? 0) >= CONSOLIDATION_MIN_CHANGES ||
				Date.now() - Date.parse(value.pendingSince ?? "") >= CONSOLIDATION_INTERVAL_MS)
		);
	}

	/** 其他到期没人管的工作区（含 unbound）：只要软件开着、有任意聊天存活，就顺带清扫，不为此新建 runtime。 */
	private listSweepWorkspaceIds(): string[] {
		const seen = new Set<string>();
		try {
			for (const key of Object.keys(readState(this.paths.statePath).consolidation)) {
				if (key && key !== this.paths.workspaceId) seen.add(key);
			}
		} catch {
			// state 读取失败不挡本工作区；顺带清扫下次再试。
		}
		try {
			const workspacesDir = getWorkspacesDir(this.paths.dataRoot);
			if (fs.existsSync(workspacesDir)) {
				for (const item of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
					if (!item.isDirectory() || !item.name || item.name === this.paths.workspaceId) continue;
					if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(item.name)) continue;
					seen.add(item.name);
				}
			}
		} catch {
			// 顺带清扫是尽力而为；失败留到下次 30 秒检查。
		}
		return [...seen];
	}

	/** 顺带清扫其他到期工作区的全局+工作区共享部分。未点开聊天的会话私密笔记仍等本人点开（防串味）。 */
	private async sweepDueWorkspaces(
		settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>,
	): Promise<void> {
		for (const workspaceId of this.listSweepWorkspaceIds()) {
			if (this.disposed) return;
			try {
				if (!this.consolidationDueFor(workspaceId)) continue;
				this.logMaintenance("sweep-start", { sweptWorkspaceId: workspaceId });
				await this.consolidateSweptWorkspace(workspaceId, settings);
				this.logMaintenance("sweep-done", { sweptWorkspaceId: workspaceId, result: "ok" });
			} catch (error) {
				this.logMaintenance("sweep-done", {
					sweptWorkspaceId: workspaceId,
					result: "failed",
					...describeMaintenanceError(error),
				});
				// 会话替换中止：静默跳过，不计失败、不报错。
				if (this.disposed) continue;
				this.reportError("consolidate", error);
				this.noteConsolidationFailure(error);
			}
		}
	}

	private async consolidateSweptWorkspace(
		workspaceId: string,
		settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>,
	): Promise<void> {
		this.assertActive();
		const dataRoot = this.paths.dataRoot;
		if (!fs.existsSync(getWorkspaceDir(dataRoot, workspaceId))) return;
		// 与本工作区的整理共用同一把串行锁；被占用则本轮跳过，留给 30 秒后的下一轮。
		if (activeConsolidations.has(workspaceId)) {
			this.logMaintenance("consolidation-skipped-busy", { workspaceId });
			return;
		}
		activeConsolidations.add(workspaceId);
		try {
			await this.consolidateSweptWorkspaceLocked(workspaceId, settings);
		} finally {
			activeConsolidations.delete(workspaceId);
		}
	}

	private async consolidateSweptWorkspaceLocked(
		workspaceId: string,
		settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>,
	): Promise<void> {
		const dataRoot = this.paths.dataRoot;
		if (!fs.existsSync(getWorkspaceDir(dataRoot, workspaceId))) return;
		const sweptPaths = getMemoryPaths({ dataRoot, workspaceId, sessionId: "sweep" });
		const revision = readState(this.paths.statePath).consolidation[workspaceId]?.revision ?? 0;
		const loadSwept = () =>
			readMemoryEntries({
				globalDir: sweptPaths.globalDir,
				projectDir: sweptPaths.workspaceDir,
				sessionDir: sweptPaths.sessionDir,
			});
		const all = loadSwept();
		if (all.length === 0) {
			this.logMaintenance("sweep-noop", { sweptWorkspaceId: workspaceId });
			return;
		}
		this.logMaintenance("sweep-consolidate-start", {
			sweptWorkspaceId: workspaceId,
			entriesCount: all.length,
			revision,
		});
		const sortedSwept = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const format = (entry: MemoryEntry) =>
			`ID: ${entry.id}\nScope: ${entry.scope}\nName: ${entry.name}\nDescription: ${entry.description}\nType: ${entry.type}${entry.importance ? `\nImportance: ${entry.importance}` : ""}${entry.triggers?.length ? `\nTriggers: ${JSON.stringify(entry.triggers)}` : ""}\nContent:\n${entry.content}`;
		for (let start = 0; start < sortedSwept.length; start += CONSOLIDATION_BATCH_SIZE) {
			this.assertActive();
			const batch = sortedSwept.slice(start, start + CONSOLIDATION_BATCH_SIZE);
			const snapshot = loadSwept();
			const output = await this.runModel({
				cwd: this.options.cwd,
				settings,
				systemPrompt: MEMORY_CONSOLIDATOR_PROMPT,
				task: `Resident user profile entry ID (maintain it only if it is listed below): ${MEMORY_PROFILE_ID}\n\nPlease consolidate the following existing memories:\n\n${batch.map(format).join("\n\n---\n\n")}`,
			});
			this.assertActive();
			const operations = parseMemoryOperations(output);
			if (operations === undefined) {
				this.logMaintenance("sweep-parse-failure", {
					sweptWorkspaceId: workspaceId,
					batchSize: batch.length,
					outputLength: output.length,
					outputPreview: truncateLogPreview(output),
				});
				throw new Error("Auto Memory 整理器返回了无效的操作格式");
			}
			const ids = new Set(batch.map((entry) => entry.id));
			await this.applyOperations(
				operations.filter((operation) => !!operation.id && ids.has(operation.id)),
				true,
				snapshot,
				undefined,
				{
					workspaceId,
					globalDir: sweptPaths.globalDir,
					projectDir: sweptPaths.workspaceDir,
					sessionDir: sweptPaths.sessionDir,
				},
			);
		}
		await this.withLock(async () => {
			const state = readState(this.paths.statePath);
			const value = state.consolidation[workspaceId];
			if (value && (value.revision ?? 0) === revision) {
				value.lastAt = new Date().toISOString();
				value.sessionIds = [];
				value.pendingChanges = 0;
				value.pendingSince = undefined;
				await writeMemoryFile(this.paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
			}
		});
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

	/** 整理连续失败计数：瞬时失败静默退避，连续 3 轮才亮黄灯，灯上带最近失败原因。 */
	private noteConsolidationFailure(error: unknown): void {
		this.consolidationFailureStreak += 1;
		if (this.consolidationFailureStreak >= 3) {
			this.setMaintenanceStatus({
				phase: "warning",
				error: `Memory maintenance failed ${this.consolidationFailureStreak} runs in a row: ${String(error).slice(0, 300)}`,
			});
		}
	}

	private noteConsolidationSuccess(): void {
		this.consolidationFailureStreak = 0;
		if (this.maintenanceStatus.phase === "warning") this.setMaintenanceStatus({ phase: "idle" });
	}

	private reportError(operation: "recall" | "extract" | "consolidate", error: unknown): void {
		this.logMaintenance("error", { operation, ...describeMaintenanceError(error) });
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
		this.logMaintenance("model-request", {
			provider: parameters.settings.provider,
			model: parameters.settings.model,
			thinkingLevel: parameters.settings.thinkingLevel,
			systemPromptLength: parameters.systemPrompt.length,
			taskLength: parameters.task.length,
			taskPreview: truncateLogPreview(parameters.task),
			customRunner: Boolean(this.options.modelRunner),
		});
		if (this.options.modelRunner) {
			try {
				const output = await this.options.modelRunner(parameters);
				this.assertActive();
				this.logMaintenance("model-response", {
					provider: parameters.settings.provider,
					model: parameters.settings.model,
					outputLength: output.length,
					outputPreview: truncateLogPreview(output),
				});
				return output;
			} catch (error) {
				this.logMaintenance("model-error", {
					provider: parameters.settings.provider,
					model: parameters.settings.model,
					...describeMaintenanceError(error),
				});
				throw error;
			}
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
					// 不写死输出上限：与主聊天一致走 provider 默认（思考与正文共用该预算）。
					// Lets provider-level session headers (e.g. `x-opencode-session`) ride the
					// conversation ID, like foreground chats do.
					sessionId: this.options.sessionId,
				},
			);
			this.assertActive();
			if (response.stopReason === "aborted") {
				this.logMaintenance("model-error", {
					provider: parameters.settings.provider,
					model: parameters.settings.model,
					stopReason: response.stopReason,
					errorMessage: "Auto Memory 请求超时或被取消",
				});
				throw new Error("Auto Memory 请求超时或被取消");
			}
			if (response.stopReason === "error") {
				this.logMaintenance("model-error", {
					provider: parameters.settings.provider,
					model: parameters.settings.model,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage || "Auto Memory 模型请求失败",
				});
				throw new Error(response.errorMessage || "Auto Memory 模型请求失败");
			}
			const output = contentText(response.content, "\n").trim();
			if (!output) {
				this.logMaintenance("model-error", {
					provider: parameters.settings.provider,
					model: parameters.settings.model,
					stopReason: response.stopReason,
					errorMessage: "Auto Memory 模型没有返回内容",
				});
				throw new Error("Auto Memory 模型没有返回内容");
			}
			this.logMaintenance("model-response", {
				provider: parameters.settings.provider,
				model: parameters.settings.model,
				stopReason: response.stopReason,
				outputLength: output.length,
				outputPreview: truncateLogPreview(output),
			});
			return output;
		} catch (error) {
			// completeSimple 本身抛错（如鉴权/超时/限流/断网）：记下完整堆栈与上下文。
			this.logMaintenance("model-error", {
				provider: parameters.settings.provider,
				model: parameters.settings.model,
				...describeMaintenanceError(error),
			});
			throw error;
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
				...selectMemoriesForQuery(query, candidates).map(({ entry }) => entry),
			];
		} catch (error) {
			this.reportError("recall", error);
			return undefined;
		}
		// 分层 token 预算：画像固定位在前，目录位其次，动态卡片用剩余额度。规矩头不占额度。
		// 目录每轮常驻：模型先看到 id 表，需要全文再用 memory_get 按需取，避免卡片截断导致“有但看不见”。
		const profile = selected.find(isMemoryProfile);
		const cards = selected.filter((entry) => entry !== profile);
		const sections: string[] = [];
		const sentIds: string[] = [];
		let usedTokens = 0;
		if (profile) {
			const section = `## ${profile.name}\nType: ${profile.type}; Scope: ${profile.scope}\n${profile.content}`;
			// 画像超长属于异常：截断到固定位，保证本轮不断流；画像本身仍要求整理器保持在 10KB 内。
			const fitted = truncateToTokenBudget(section, RECALL_PROFILE_TOKEN_RESERVE);
			sections.push(fitted);
			sentIds.push(profile.id);
			usedTokens += estimateMemoryTokens(fitted);
		}

		const directoryRows = [...candidates]
			.filter((entry) => !isMemoryProfile(entry))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map(
				(entry) =>
					`${entry.id} | ${entry.scope} | ${entry.name} | ${shortenDirectoryDescription(entry.description)}`,
			);
		const directoryLines = ["记忆目录（本轮可见范围；用 memory_get 按 id 取全文）：", ...directoryRows];
		const directory: string[] = [];
		let directoryTokens = 0;
		for (const line of directoryLines) {
			const lineTokens = estimateMemoryTokens(`${line}\n`);
			if (directory.length > 0 && directoryTokens + lineTokens > RECALL_DIRECTORY_TOKEN_BUDGET) break;
			directory.push(line);
			directoryTokens += lineTokens;
		}
		if (directory.length < directoryLines.length) {
			directory.push(
				`[…目录过长，只列出前 ${directory.length - 1} 条，共 ${directoryRows.length} 条。带 query 用 memory_search 缩小范围。]`,
			);
		}
		sections.push(directory.join("\n"));

		const directoryTokensUsed = estimateMemoryTokens(sections[sections.length - 1]);
		const budget = RECALL_TOTAL_TOKEN_BUDGET - usedTokens - directoryTokensUsed;
		let cardTokens = 0;
		for (const entry of cards) {
			const section = `## ${entry.name}\nType: ${entry.type}; Scope: ${entry.scope}\n${entry.content}`;
			const sectionTokens = estimateMemoryTokens(section);
			// 装不下的卡片跳过、继续尝试后面更小的卡片，而不是整段停止。
			if (cardTokens + sectionTokens > Math.max(0, budget)) continue;
			sections.push(section);
			cardTokens += sectionTokens;
			sentIds.push(entry.id);
		}
		// 只要目录非空就注入：画像与卡片全空时 details.ids 为空数组，语义仍是“画像+卡片 id”。

		return {
			role: "custom",
			customType: "auto-memory-recall",
			content: `${MEMORY_CONTEXT_RULES}\n\n<recalled_memory_context>\n${sections.join("\n\n")}\n</recalled_memory_context>`,
			display: false,
			details: { ids: sentIds },
			timestamp: Date.now(),
		};
	}

	scheduleExtraction(entries: SessionEntry[]): void {
		if (this.disposed) return;
		void this.runExtraction(entries).catch((error) => {
			// 会话替换中止：静默退出，不计失败、不报错。
			if (this.disposed) return;
			this.reportError("extract", error);
		});
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
				// 会话替换导致的中止：静默退出，不计失败、不报错。
				if (this.disposed) return false;
				this.reportError("extract", error);
				return false;
			}
		});
		this.backgroundQueue = result.then(
			() => undefined,
			(error) => {
				if (this.disposed) return;
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
		scopeContext?: {
			workspaceId: string;
			sessionId?: string;
			globalDir: string;
			projectDir: string;
			sessionDir: string;
		},
	): Promise<void> {
		this.assertActive();
		const ctxWorkspaceId = scopeContext ? scopeContext.workspaceId : this.paths.workspaceId;
		const ctxSessionId = scopeContext ? scopeContext.sessionId : this.paths.sessionId;
		await this.withLock(async () => {
			const existing = new Map(
				(scopeContext
					? readMemoryEntries({
							globalDir: scopeContext.globalDir,
							projectDir: scopeContext.projectDir,
							sessionDir: scopeContext.sessionDir,
						})
					: this.loadEntries()
				).map((entry) => [entry.id, entry]),
			);
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
			for (const operation of operations) {
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
				// The resident profile is exempt: this lets the consolidator create its first version.
				// The scope/id prefix check below still applies (must be global/用户画像 with scope global).
				const isProfileBootstrap = operation.id === MEMORY_PROFILE_ID && scope === "global";
				if (allowDelete && !isProfileBootstrap && (!operation.id || existing.get(operation.id)?.scope !== scope))
					continue;
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
				const directory = scopeContext
					? scope === "global"
						? scopeContext.globalDir
						: scope === "session"
							? scopeContext.sessionDir
							: scopeContext.projectDir
					: scope === "global"
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
					workspaceId: scope === "global" ? undefined : ctxWorkspaceId,
					sessionId: scope === "session" ? ctxSessionId : undefined,
					sourceEntryId: sourceEntryId ?? previous?.sourceEntryId,
					sourceWorkspaceId: sourceEntryId ? ctxWorkspaceId : previous?.sourceWorkspaceId,
					sourceSessionId: sourceEntryId ? ctxSessionId : previous?.sourceSessionId,
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
				const value = state.consolidation[ctxWorkspaceId] ?? { sessionIds: [] };
				value.pendingChanges = (value.pendingChanges ?? 0) + changedCount;
				value.pendingSince ??= new Date().toISOString();
				value.revision = (value.revision ?? 0) + 1;
				state.consolidation[ctxWorkspaceId] = value;
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
		// 切块推进：226 条这种大任务按 30 条一切，成一块就把游标往前推一块，
		// 坏一块只抛那一块，已成的游标已落盘，下次重试从新游标往后接着记。
		let cursor = readState(this.paths.statePath).sessions[this.options.sessionId]?.lastEntryId;
		let shouldConsolidate = false;
		let didWork = false;
		this.logMaintenance("extract-start", { totalEntries: entries.length, cursor });
		for (let start = 0; start < entries.length; start += EXTRACT_CHUNK_ENTRIES) {
			this.assertActive();
			const chunk = entries.slice(start, start + EXTRACT_CHUNK_ENTRIES);
			const transcript = formatTranscript(chunk, cursor);
			if (!transcript.text || !transcript.lastEntryId) continue;
			didWork = true;
			const existing = this.loadEntries();
			this.logMaintenance("extract-chunk-start", {
				chunkIndex: Math.floor(start / EXTRACT_CHUNK_ENTRIES),
				chunkSize: chunk.length,
				transcriptLength: transcript.text.length,
				transcriptPreview: truncateLogPreview(transcript.text),
				existingCount: existing.length,
				cursor,
				lastEntryId: transcript.lastEntryId,
			});
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
			if (operations === undefined) {
				this.logMaintenance("extract-parse-failure", {
					chunkIndex: Math.floor(start / EXTRACT_CHUNK_ENTRIES),
					outputLength: output.length,
					outputPreview: truncateLogPreview(output),
					lastEntryId: transcript.lastEntryId,
				});
				throw new Error("Auto Memory 返回了无效的操作格式");
			}
			this.logMaintenance("extract-parse-success", {
				chunkIndex: Math.floor(start / EXTRACT_CHUNK_ENTRIES),
				operationCount: operations.length,
				lastEntryId: transcript.lastEntryId,
			});
			try {
				await this.applyOperations(operations, false, existing, transcript.lastEntryId);
				this.logMaintenance("extract-apply-success", {
					chunkIndex: Math.floor(start / EXTRACT_CHUNK_ENTRIES),
					operationCount: operations.length,
					lastEntryId: transcript.lastEntryId,
				});
			} catch (error) {
				this.logMaintenance("extract-apply-error", {
					chunkIndex: Math.floor(start / EXTRACT_CHUNK_ENTRIES),
					operationCount: operations.length,
					lastEntryId: transcript.lastEntryId,
					...describeMaintenanceError(error),
				});
				throw error;
			}
			this.assertActive();
			const updated = await this.updateState(transcript.lastEntryId);
			cursor = transcript.lastEntryId;
			if (updated.shouldConsolidate) shouldConsolidate = true;
		}
		if (!didWork) {
			this.logMaintenance("extract-noop", { totalEntries: entries.length });
			return;
		}
		this.logMaintenance("extract-done", { totalEntries: entries.length, shouldConsolidate });
		if (shouldConsolidate) {
			try {
				await this.consolidate(settings);
				this.noteConsolidationSuccess();
			} catch (error) {
				this.logMaintenance("extract-consolidate-error", { ...describeMaintenanceError(error) });
				// 会话替换中止：静默退出，不计失败、不亮灯。
				if (this.disposed) return;
				this.reportError("consolidate", error);
				this.noteConsolidationFailure(error);
			}
		}
	}

	private async consolidate(
		settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>,
	): Promise<void> {
		this.assertActive();
		// 按工作区串行：同一工作区同时只允许一个整理在跑（含其他会话的清扫路径）。
		// 被占用则本轮跳过，30 秒后由定时器自然排队；快照乐观校验保留为安全网。
		if (activeConsolidations.has(this.paths.workspaceId)) {
			this.logMaintenance("consolidation-skipped-busy", { workspaceId: this.paths.workspaceId });
			return;
		}
		activeConsolidations.add(this.paths.workspaceId);
		try {
			await this.consolidateLocked(settings);
		} finally {
			activeConsolidations.delete(this.paths.workspaceId);
		}
	}

	private async consolidateLocked(
		settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>,
	): Promise<void> {
		const revision = readState(this.paths.statePath).consolidation[this.paths.workspaceId]?.revision ?? 0;
		const entries = this.loadEntries();
		// 候选矛盾对：本地只读启发式先圈定“同一话题的两条旧记忆”，由整理器模型核实是否真矛盾。
		// 真矛盾按新胜旧合并（旧版本自动归档）；同一话题但不矛盾则不动，避免误删。
		const contradictions = findMemoryContradictions(entries);
		this.logMaintenance("consolidate-start", {
			entriesCount: entries.length,
			revision,
			contradictionPairs: contradictions.length,
		});
		// 稳定性切块：按 20 张一批独立存，成一批落一批，坏一批只记那一批的错继续往下走，
		// 最后有错再抛出来变黄并保留 pending，下次定时器接着整。
		// 画像逐出按 updatedAt 倒序切批的集合，固定插入第一个批次（允许该批 21 条），保证每轮必定重写且不重复出现在两个批次。
		const profile = entries.find(isMemoryProfile);
		const sorted = entries
			.filter((entry) => entry !== profile)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const batches: MemoryEntry[][] = [];
		for (let start = 0; start < sorted.length; start += CONSOLIDATION_BATCH_SIZE) {
			batches.push(sorted.slice(start, start + CONSOLIDATION_BATCH_SIZE));
		}
		if (profile) {
			if (batches.length === 0) batches.push([profile]);
			else batches[0].unshift(profile);
		}
		// entries 为空时 batches 为空，本轮不跑批（维持现状）。
		const profileTaskPrefix = profile
			? `Resident user profile entry ID: ${MEMORY_PROFILE_ID} (its full text is included in this batch; rewrite the whole entry as usual)`
			: `Resident user profile entry ID: ${MEMORY_PROFILE_ID} (it does not exist yet; you may create its first version from facts already present in this batch only if they contain enough stable identity, communication or workflow facts; otherwise skip it and never invent facts)`;
		const otherBatchPrefix = `Resident user profile entry ID: ${MEMORY_PROFILE_ID} (it is maintained in another batch; do not create or modify it in this batch)`;
		const format = (entry: MemoryEntry) =>
			`ID: ${entry.id}\nScope: ${entry.scope}\nName: ${entry.name}\nDescription: ${entry.description}\nType: ${entry.type}${entry.importance ? `\nImportance: ${entry.importance}` : ""}${entry.triggers?.length ? `\nTriggers: ${JSON.stringify(entry.triggers)}` : ""}\nContent:\n${entry.content}`;
		let firstError: unknown;
		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			const batch = batches[batchIndex];
			if (batch.length === 0) continue;
			this.logMaintenance("consolidate-batch-start", {
				batchIndex,
				batchCount: batches.length,
				batchSize: batch.length,
				batchIds: batch.map((entry) => entry.id),
			});
			try {
				const snapshot = this.loadEntries();
				const batchIds = new Set(batch.map((entry) => entry.id));
				const batchContradictions = contradictions.filter(
					(pair) => batchIds.has(pair.a.id) || batchIds.has(pair.b.id),
				);
				const contradictionSection =
					batchContradictions.length === 0
						? ""
						: `\n\nCandidate contradiction pairs (local heuristic, verify before acting; if a pair truly contradicts, merge with the newer winning and let the old version archive; if they are merely about the same topic, leave them alone):\n\n${batchContradictions
								.map(
									(pair) =>
										`OLD ${pair.a.id} (${pair.a.updatedAt}): ${pair.a.content}\nNEW ${pair.b.id} (${pair.b.updatedAt}): ${pair.b.content}\nShared topic terms: ${pair.sharedTerms.join(", ")}${pair.cues.length > 0 ? `\nCorrective cues: ${pair.cues.join(", ")}` : ""}`,
								)
								.join("\n\n---\n\n")}`;
				const output = await this.runModel({
					cwd: this.options.cwd,
					settings,
					systemPrompt: MEMORY_CONSOLIDATOR_PROMPT,
					task: `${batchIndex === 0 ? profileTaskPrefix : otherBatchPrefix}\n\nPlease consolidate the following existing memories:\n\n${batch.map(format).join("\n\n---\n\n")}${contradictionSection}`,
				});
				this.assertActive();
				const operations = parseMemoryOperations(output);
				if (operations === undefined) {
					this.logMaintenance("consolidate-parse-failure", {
						batchIndex,
						batchSize: batch.length,
						outputLength: output.length,
						outputPreview: truncateLogPreview(output),
					});
					throw new Error("Auto Memory 整理器返回了无效的操作格式");
				}
				// batchIndex 0 放行画像操作（新建或重写）；其它批次沿用白名单，画像操作被丢弃。
				const filtered = operations.filter(
					(operation) =>
						!!operation.id &&
						(batchIds.has(operation.id) || (batchIndex === 0 && operation.id === MEMORY_PROFILE_ID)),
				);
				try {
					await this.applyOperations(filtered, true, snapshot);
					this.logMaintenance("consolidate-batch-done", {
						batchIndex,
						batchSize: batch.length,
						operationCount: operations.length,
						appliedCount: filtered.length,
						result: "ok",
					});
				} catch (error) {
					this.logMaintenance("consolidate-batch-done", {
						batchIndex,
						batchSize: batch.length,
						operationCount: operations.length,
						result: "failed",
						...describeMaintenanceError(error),
					});
					throw error;
				}
			} catch (error) {
				this.reportError("consolidate", error);
				if (firstError === undefined) firstError = error;
			}
		}
		if (firstError !== undefined) {
			this.logMaintenance("consolidate-done", {
				entriesCount: entries.length,
				batchCount: batches.length,
				result: "failed",
				...describeMaintenanceError(firstError),
			});
			throw firstError;
		}
		this.logMaintenance("consolidate-done", {
			entriesCount: entries.length,
			batchCount: batches.length,
			result: "ok",
		});
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
