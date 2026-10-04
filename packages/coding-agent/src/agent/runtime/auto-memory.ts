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
	workspaceId?: string;
	sessionId?: string;
}

export interface MemoryOperation {
	action: "upsert" | "delete";
	id?: string;
	scope?: MemoryScope;
	type?: MemoryType;
	name?: string;
	description?: string;
	content?: string;
}

interface MemoryState {
	version: 1;
	sessions: Record<string, { lastEntryId?: string; updatedAt: string }>;
	consolidation: Record<string, { lastAt?: string; sessionIds: string[] }>;
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
	modelRunner?: AutoMemoryModelRunner;
}

export type AutoMemoryModelRunner = (options: {
	cwd: string;
	settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>;
	systemPrompt: string;
	task: string;
}) => Promise<string>;

const MEMORY_FILE_LIMIT = 200;
const MEMORY_BODY_MAX_BYTES = 4 * 1024;
const RECALL_TURN_MAX_BYTES = 20 * 1024;
const RECALL_SESSION_MAX_BYTES = 60 * 1024;
const EXTRACTION_TRANSCRIPT_MAX_BYTES = 24 * 1024;
const EXTRACTION_MANIFEST_MAX_BYTES = 16 * 1024;
const CONSOLIDATION_INPUT_MAX_BYTES = 60 * 1024;
const MAX_RECALLED_MEMORIES = 5;
const CONSOLIDATION_MIN_SESSIONS = 5;
const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_MEMORY_TIMEOUT_MS = 5 * 60 * 1000;
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

function isSafeMemoryId(id: string): boolean {
	return /^(global|workspace|session|project)\/[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(id);
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
			workspaceId: typeof parsed.frontmatter.workspaceId === "string" ? parsed.frontmatter.workspaceId : undefined,
			sessionId: typeof parsed.frontmatter.sessionId === "string" ? parsed.frontmatter.sessionId : undefined,
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
		if (entries.length >= MEMORY_FILE_LIMIT) break;
		if (!item.isFile() || !item.name.endsWith(".md")) continue;
		assertDirectPath(path.join(directory, item.name));
		const entry = parseMemoryFile(path.join(directory, item.name), scope);
		if (entry) entries.push(entry);
	}
	return entries;
}

function serializeMemory(entry: MemoryEntry): string {
	const frontmatter = stringifyYaml({
		id: entry.id,
		name: entry.name,
		description: entry.description,
		type: entry.type,
		scope: entry.scope,
		workspaceId: entry.workspaceId,
		sessionId: entry.sessionId,
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
	const rows: Array<Record<string, string>> = [];
	let bytes = 2;
	for (const { id, name, description, type, scope, updatedAt } of entries) {
		const row = { id, name, description, type, scope, updatedAt };
		const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
		if (rows.length > 0 && bytes + rowBytes > EXTRACTION_MANIFEST_MAX_BYTES) break;
		rows.push(row);
		bytes += rowBytes;
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

function lexicalSelection(query: string, entries: MemoryEntry[]): MemoryEntry[] {
	const terms = lexicalTerms(query);
	if (terms.size === 0) return [];
	return entries
		.map((entry, index) => {
			const haystack = `${entry.name}\n${entry.description}\n${entry.content}`.toLowerCase();
			let score = 0;
			for (const term of terms) {
				if (haystack.includes(term)) score++;
			}
			return { entry, score, index };
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, MAX_RECALLED_MEMORIES)
		.map((item) => item.entry);
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

	const selected: typeof candidates = [];
	let bytes = 0;
	for (let index = candidates.length - 1; index >= 0; index--) {
		const item = candidates[index];
		const formatted = `${item.role === "user" ? "User" : "Main AI"}:\n${item.text}\n`;
		const itemBytes = Buffer.byteLength(formatted, "utf8");
		if (selected.length > 0 && bytes + itemBytes > EXTRACTION_TRANSCRIPT_MAX_BYTES) break;
		selected.push(item);
		bytes += itemBytes;
	}
	selected.reverse();
	return {
		text: selected.map((item) => `${item.role === "user" ? "User" : "Main AI"}:\n${item.text}`).join("\n\n"),
		lastEntryId: candidates.at(-1)?.id,
	};
}

export class AutoMemoryManager {
	private readonly options: AutoMemoryManagerOptions;
	private initializedPaths?: AutoMemoryPaths;
	private readonly recalledIds = new Set<string>();
	private readonly reportedErrors = new Set<string>();
	private recalledBytes = 0;
	private backgroundQueue: Promise<void> = Promise.resolve();
	private readonly disposeController = new AbortController();
	private disposed = false;

	constructor(options: AutoMemoryManagerOptions) {
		this.options = options;
	}

	/** Invalidate background work owned by a replaced AgentSession. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
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
			const configuredIdleTimeout = this.options.settingsManager.getHttpIdleTimeoutMs();
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
					timeoutMs: configuredIdleTimeout === 0 ? AUTO_MEMORY_TIMEOUT_MS : configuredIdleTimeout,
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
		return [
			...scanMemoryDirectory(this.paths.globalDir, "global"),
			...scanMemoryDirectory(this.paths.projectDir, "workspace"),
			...scanMemoryDirectory(this.paths.sessionDir, "session"),
		]
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, MEMORY_FILE_LIMIT);
	}

	async recall(query: string): Promise<CustomMessage | undefined> {
		if (this.disposed) return undefined;
		const settings = this.getSettings();
		if (!settings || this.recalledBytes >= RECALL_SESSION_MAX_BYTES) return undefined;
		let candidates: MemoryEntry[];
		try {
			await migrateLegacyMemories(this.paths.dataRoot, this.options.agentDir);
			candidates = this.loadEntries().filter((entry) => !this.recalledIds.has(entry.id));
		} catch (error) {
			this.reportError("recall", error);
			return undefined;
		}
		if (candidates.length === 0) return undefined;

		// Recall must never delay sending the user's message. The selected model is
		// still used for background extraction and consolidation; retrieval itself
		// is a bounded local operation.
		const selected = lexicalSelection(truncateUtf8(query, 12 * 1024), candidates);
		if (selected.length === 0) return undefined;

		const sections: string[] = [];
		let turnBytes = Buffer.byteLength(MEMORY_CONTEXT_RULES, "utf8");
		for (const entry of selected) {
			const section = `## ${entry.name}\nType: ${entry.type}; Scope: ${entry.scope}\n${entry.content}`;
			const sectionBytes = Buffer.byteLength(section, "utf8");
			if (
				sections.length > 0 &&
				(turnBytes + sectionBytes > RECALL_TURN_MAX_BYTES ||
					this.recalledBytes + turnBytes + sectionBytes > RECALL_SESSION_MAX_BYTES)
			) {
				break;
			}
			sections.push(section);
			turnBytes += sectionBytes;
			this.recalledIds.add(entry.id);
		}
		if (sections.length === 0) return undefined;
		this.recalledBytes += turnBytes;

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

	private async applyOperations(operations: MemoryOperation[], allowDelete: boolean): Promise<void> {
		this.assertActive();
		await this.withLock(async () => {
			const existing = new Map(this.loadEntries().map((entry) => [entry.id, entry]));
			for (const operation of operations.slice(0, 20)) {
				this.assertActive();
				if (operation.action === "delete") {
					if (!allowDelete) continue;
					if (!operation.id || !isSafeMemoryId(operation.id)) continue;
					const target = existing.get(operation.id);
					if (!target) continue;
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
					workspaceId: scope === "global" ? undefined : this.paths.workspaceId,
					sessionId: scope === "session" ? this.paths.sessionId : undefined,
				};
				this.assertActive();
				if (previous) await archiveMemoryFile(previous.filePath, "updated");
				await writeMemoryFile(filePath, serializeMemory(entry));
				if (previous && previous.filePath !== filePath) await fs.promises.unlink(previous.filePath);
				existing.set(id, entry);
			}
			await this.writeIndex();
		});
	}

	private async updateState(lastEntryId: string, markConsolidated = false): Promise<{ shouldConsolidate: boolean }> {
		this.assertActive();
		return this.withLock(async () => {
			const state = readState(this.paths.statePath);
			const now = new Date();
			state.sessions[this.options.sessionId] = { lastEntryId, updatedAt: now.toISOString() };
			const sessionEntries = Object.entries(state.sessions)
				.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
				.slice(0, 100);
			state.sessions = Object.fromEntries(sessionEntries);
			const consolidation = state.consolidation[this.paths.workspaceId] ?? { sessionIds: [] };
			state.consolidation[this.paths.workspaceId] = consolidation;
			if (!consolidation.sessionIds.includes(this.options.sessionId)) {
				consolidation.sessionIds.push(this.options.sessionId);
			}
			if (markConsolidated) {
				consolidation.lastAt = now.toISOString();
				consolidation.sessionIds = [];
			}
			const lastAt = consolidation.lastAt ? Date.parse(consolidation.lastAt) : 0;
			const shouldConsolidate =
				!markConsolidated &&
				consolidation.sessionIds.length >= CONSOLIDATION_MIN_SESSIONS &&
				Date.now() - lastAt >= CONSOLIDATION_INTERVAL_MS;
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
				`Current project root: ${this.paths.projectRoot}\nWorkspace ID: ${this.paths.workspaceId}\nSession ID: ${this.paths.sessionId}`,
				`Existing memory list:\n${formatManifest(existing)}`,
				`New conversation since last extraction:\n${transcript.text}`,
			].join("\n\n"),
		});
		this.assertActive();
		const operations = parseMemoryOperations(output);
		if (operations === undefined) throw new Error("Auto Memory 返回了无效的操作格式");
		await this.applyOperations(operations.slice(0, 12), false);
		this.assertActive();
		const { shouldConsolidate } = await this.updateState(transcript.lastEntryId);
		if (shouldConsolidate) {
			try {
				await this.consolidate(settings, transcript.lastEntryId);
			} catch (error) {
				this.reportError("consolidate", error);
			}
		}
	}

	private async consolidate(
		settings: Required<Pick<AutoMemorySettings, "provider" | "model" | "thinkingLevel">>,
		lastEntryId: string,
	): Promise<void> {
		this.assertActive();
		const entries = this.loadEntries();
		if (entries.length === 0) {
			await this.updateState(lastEntryId, true);
			return;
		}
		const chunks: string[] = [];
		let bytes = 0;
		for (const entry of entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
			const chunk = `ID: ${entry.id}\nName: ${entry.name}\nDescription: ${entry.description}\nType: ${entry.type}\nContent:\n${entry.content}`;
			const chunkBytes = Buffer.byteLength(chunk, "utf8");
			if (chunks.length > 0 && bytes + chunkBytes > CONSOLIDATION_INPUT_MAX_BYTES) break;
			chunks.push(chunk);
			bytes += chunkBytes;
		}
		const output = await this.runModel({
			cwd: this.options.cwd,
			settings,
			systemPrompt: MEMORY_CONSOLIDATOR_PROMPT,
			task: `Please consolidate the following existing memories:\n\n${chunks.join("\n\n---\n\n")}`,
		});
		this.assertActive();
		const operations = parseMemoryOperations(output);
		if (operations === undefined) throw new Error("Auto Memory 整理器返回了无效的操作格式");
		await this.applyOperations(operations, true);
		await this.updateState(lastEntryId, true);
	}
}
