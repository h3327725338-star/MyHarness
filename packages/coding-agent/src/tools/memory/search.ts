import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import {
	type CrossScopeMemoryEntry,
	isSafeMemoryId,
	type MemoryEntry,
	type MemoryScope,
	readCrossScopeMemoryEntries,
	readMemoryEntries,
	sanitizeMemoryText,
	selectMemoriesForQuery,
} from "../../agent/runtime/auto-memory.ts";
import { getDataDir, UNBOUND_WORKSPACE_ID } from "../../config/paths/index.ts";
import type { SettingsManager } from "../../config/settings/index.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { getMemoryPaths } from "../../session/memory/store.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import type { MemoryManageOperations } from "./manage.ts";

const DIRECTORY_MAX_BYTES = 16 * 1024;
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 20;
const GET_MAX_IDS = 5;
const EXCERPT_MAX_CHARS = 140;
const DISABLED_TEXT = "Auto Memory 未启用（已在设置中关闭，或当前会话不保存记忆），记忆工具不可用。";

const memoryScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("workspace"), Type.Literal("session")], {
	description: "Only look at memories of this scope.",
});

const memorySearchSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description:
				"What to look for, in the user's own words. Omit it to list the whole memory directory instead of searching.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: `Most results to return (1-${SEARCH_MAX_LIMIT}). Default ${SEARCH_DEFAULT_LIMIT}.` }),
	),
	scope: Type.Optional(memoryScopeSchema),
});

const memoryGetSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Memory id, for example global/some-memory." })),
	ids: Type.Optional(
		Type.Array(Type.String(), { description: `Several memory ids at once (at most ${GET_MAX_IDS}).` }),
	),
});

export type MemorySearchToolInput = Static<typeof memorySearchSchema>;
export type MemoryGetToolInput = Static<typeof memoryGetSchema>;

export interface MemoryToolDetails {
	mode: "disabled" | "directory" | "search" | "get" | "error";
	/** Memories visible to this conversation (or, for get, ids asked for). */
	total?: number;
	returned?: number;
	ids?: string[];
	truncated?: boolean;
}

/**
 * Pluggable access to the memory of one conversation. The default has none, which reads as "Auto Memory is off".
 * Implementations must only read.
 */
export interface MemoryToolOperations {
	/** The active memories visible to this conversation, or undefined when Auto Memory is off for it. */
	loadEntries: () => MemoryEntry[] | undefined;
	/**
	 * Cross-scope memories (other workspaces/sessions + pending quarantine), same gating.
	 * Absent in custom operations: treated as empty. Automatic recall never uses these.
	 */
	loadCrossEntries?: () => CrossScopeMemoryEntry[];
}

export interface MemoryToolOptions {
	operations?: MemoryToolOperations;
	/** Write access for memory_delete/memory_claim; absent means read-only custom operations. */
	manageOperations?: MemoryManageOperations;
}

const unavailableOperations: MemoryToolOperations = { loadEntries: () => undefined };

/** Memory access for a live session: its own Data root, workspace and conversation, gated by the Auto Memory setting. */
export function createSessionMemoryOperations(source: {
	sessionManager: Pick<SessionManager, "isPersisted" | "getDataRoot" | "getWorkspaceId" | "getSessionId">;
	settingsManager: Pick<SettingsManager, "getAutoMemorySettings">;
}): MemoryToolOperations {
	const resolveLocation = () => ({
		dataRoot: source.sessionManager.getDataRoot() ?? getDataDir(),
		workspaceId: source.sessionManager.getWorkspaceId() ?? UNBOUND_WORKSPACE_ID,
		sessionId: source.sessionManager.getSessionId(),
	});
	return {
		loadEntries() {
			const { sessionManager, settingsManager } = source;
			if (!sessionManager.isPersisted() || !settingsManager.getAutoMemorySettings().enabled) return undefined;
			const location = resolveLocation();
			const paths = getMemoryPaths({
				dataRoot: location.dataRoot,
				workspaceId: location.workspaceId,
				sessionId: location.sessionId,
			});
			return readMemoryEntries({
				globalDir: paths.globalDir,
				projectDir: paths.workspaceDir,
				sessionDir: paths.sessionDir,
			});
		},
		loadCrossEntries() {
			const { sessionManager, settingsManager } = source;
			if (!sessionManager.isPersisted() || !settingsManager.getAutoMemorySettings().enabled) return [];
			const location = resolveLocation();
			return readCrossScopeMemoryEntries(location.dataRoot, {
				workspaceId: location.workspaceId,
				sessionId: location.sessionId,
			});
		},
	};
}

/** Memory text is user data on its way to the model: keep the stored redaction and never show a private key. */
function safeText(value: string): string {
	try {
		return sanitizeMemoryText(value);
	} catch {
		return "[内容包含私钥，已隐藏]";
	}
}

/** One table cell: a single line without the column separator. */
function cell(value: string, maxChars = 300): string {
	const oneLine = safeText(value).replace(/\s+/g, " ").replace(/\|/g, "/");
	return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}

function importanceOf(entry: MemoryEntry): string {
	return entry.importance ?? "normal";
}

function textResult(text: string, details: MemoryToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function loadVisibleEntries(
	ops: MemoryToolOperations,
): { entries: MemoryEntry[]; cross: CrossScopeMemoryEntry[] } | { failure: ReturnType<typeof textResult> } {
	try {
		const entries = ops.loadEntries();
		if (!entries) return { failure: textResult(DISABLED_TEXT, { mode: "disabled" }) };
		let cross: CrossScopeMemoryEntry[] = [];
		try {
			cross = ops.loadCrossEntries?.() ?? [];
		} catch {
			cross = [];
		}
		return { entries, cross };
	} catch (error) {
		return { failure: textResult(`记忆读取失败：${cell(describeError(error))}`, { mode: "error" }) };
	}
}

function crossScopeLabel(entry: CrossScopeMemoryEntry): string {
	return entry.kind === "pending" ? entry.originLabel : `跨项目 · ${entry.originLabel}`;
}

function formatDirectory(
	entries: MemoryEntry[],
	cross: CrossScopeMemoryEntry[],
	limit: number | undefined,
): ReturnType<typeof textResult> {
	const sorted = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const sortedCross = [...cross].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const header = "id | name | description | importance | type | scope | updatedAt | origin";
	const rows: string[] = [];
	const ids: string[] = [];
	let bytes = Buffer.byteLength(header, "utf8");
	const pushRow = (row: string, id: string): boolean => {
		const rowBytes = Buffer.byteLength(row, "utf8") + 1;
		if (rows.length > 0 && bytes + rowBytes > DIRECTORY_MAX_BYTES) return false;
		rows.push(row);
		ids.push(id);
		bytes += rowBytes;
		return true;
	};
	for (const entry of sorted) {
		if (limit !== undefined && rows.length >= limit) break;
		const row = [
			entry.id,
			cell(entry.name, 120),
			cell(entry.description),
			importanceOf(entry),
			entry.type,
			entry.scope,
			entry.updatedAt,
			"",
		].join(" | ");
		if (!pushRow(row, entry.id)) break;
	}
	for (const entry of sortedCross) {
		if (limit !== undefined && rows.length >= limit) break;
		const row = [
			entry.id,
			cell(entry.name, 120),
			cell(entry.description),
			entry.importance ?? "normal",
			entry.type,
			entry.scope,
			entry.updatedAt,
			crossScopeLabel(entry),
		].join(" | ");
		if (!pushRow(row, entry.id)) break;
	}
	const total = sorted.length + sortedCross.length;
	const truncated = rows.length < total;
	const lines = [
		`记忆目录：共 ${total} 条（本轮 ${sorted.length} 条，跨项目/待认领 ${sortedCross.length} 条），按更新时间由新到旧。用 memory_get 读取全文。`,
		header,
		...rows,
	];
	if (truncated) {
		lines.push(`[已截断：只列出前 ${rows.length} 条，共 ${total} 条。带 query 调用可缩小范围。]`);
	}
	if (total === 0) lines.push("（当前没有可见的记忆。）");
	return textResult(lines.join("\n"), {
		mode: "directory",
		total,
		returned: rows.length,
		ids,
		truncated,
	});
}

function formatSearch(
	query: string,
	entries: MemoryEntry[],
	cross: CrossScopeMemoryEntry[],
	limit: number,
	scope: MemoryScope | undefined,
): ReturnType<typeof textResult> {
	const ownResults = selectMemoriesForQuery(query, entries, { scope });
	// 跨项目/待认领条目参与同一套词面排序（pending 在排序时按 workspace 归一化，仅用于打分，不改变展示）。
	const rankableCross = new Map<MemoryEntry, CrossScopeMemoryEntry>();
	for (const item of cross) {
		if (scope !== undefined && item.scope !== scope) continue;
		const rankable: MemoryEntry = {
			id: item.id,
			name: item.name,
			description: item.description,
			type: item.type,
			scope: item.scope === "pending" ? "workspace" : item.scope,
			content: item.content,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
			filePath: item.sourcePath,
			importance: item.importance,
			triggers: item.triggers,
			workspaceId: item.workspaceId,
			sessionId: item.sessionId,
		};
		rankableCross.set(rankable, item);
	}
	const crossResults = selectMemoriesForQuery(query, [...rankableCross.keys()]);
	const merged = [
		...ownResults.map((result) => ({ ...result, cross: undefined as CrossScopeMemoryEntry | undefined })),
	];
	for (const result of crossResults) merged.push({ ...result, cross: rankableCross.get(result.entry) });
	merged.sort(
		(a, b) =>
			(a.via === b.via ? 0 : a.via === "trigger" ? -1 : 1) ||
			b.score - a.score ||
			b.entry.updatedAt.localeCompare(a.entry.updatedAt),
	);
	const seen = new Set<string>();
	const results = merged
		.filter((result) => {
			if (seen.has(result.entry.id)) return false;
			seen.add(result.entry.id);
			return true;
		})
		.slice(0, Math.max(0, limit));
	const ids = results.map(({ entry }) => entry.id);
	if (results.length === 0) {
		return textResult("没有匹配的记忆。不带 query 调用 memory_search 可以查看完整目录。", {
			mode: "search",
			total: entries.length + cross.length,
			returned: 0,
			ids,
		});
	}
	const lines = [`找到 ${results.length} 条相关记忆（摘要，不含全文；用 memory_get 读取全文）：`];
	results.forEach(({ entry, via, cross: crossEntry }, index) => {
		const excerpt = cell(entry.content, EXCERPT_MAX_CHARS);
		const importance = entry.importance ?? "normal";
		const origin = crossEntry ? ` | 来源：${crossScopeLabel(crossEntry)}` : "";
		lines.push(
			`${index + 1}. ${entry.id} | ${cell(entry.name, 120)} | ${importance} | ${entry.type} | ${entry.scope} | ${entry.updatedAt} | 命中：${via === "trigger" ? "触发词" : "关键词"}${origin}`,
			`   说明：${cell(entry.description)}`,
			`   摘录：${excerpt}`,
		);
	});
	return textResult(lines.join("\n"), {
		mode: "search",
		total: entries.length + cross.length,
		returned: results.length,
		ids,
	});
}

export function createMemorySearchToolDefinition(
	_cwd: string,
	options?: MemoryToolOptions,
): BusinessToolDefinition<typeof memorySearchSchema, MemoryToolDetails> {
	const ops = options?.operations ?? unavailableOperations;
	return {
		name: "memory_search",
		label: "memory_search",
		description:
			"Search the long-term memory of this conversation plus cross-project and pending-quarantine entries. Without a query it lists the memory directory: id, name, description, importance, type, scope, update time and origin, newest first. With a query it ranks memories exactly as automatic recall does and returns short summaries, not full text; use memory_get for the full text. The resident user profile (global/用户画像) is sent with every message and is not part of query results. Automatic recall itself only injects this conversation's own three layers. Read-only.",
		promptSnippet: loadSystemPrompt("tools/memory-search/snippet.md"),
		parameters: memorySearchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, { query, limit, scope }: MemorySearchToolInput, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const loaded = loadVisibleEntries(ops);
			if ("failure" in loaded) return loaded.failure;
			const scoped = scope ? loaded.entries.filter((entry) => entry.scope === scope) : loaded.entries;
			const scopedCross = scope === undefined ? loaded.cross : loaded.cross.filter((entry) => entry.scope === scope);
			const requested = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : undefined;
			const bounded = requested === undefined ? undefined : Math.min(SEARCH_MAX_LIMIT, Math.max(1, requested));
			if (!query?.trim()) return formatDirectory(scoped, scopedCross, bounded);
			return formatSearch(query, loaded.entries, loaded.cross, bounded ?? SEARCH_DEFAULT_LIMIT, scope);
		},
	};
}

function formatMemory(entry: MemoryEntry, origin?: string): string {
	const header = [
		`=== ${entry.id} ===`,
		`name: ${cell(entry.name, 200)}`,
		`type: ${entry.type}; scope: ${entry.scope}; importance: ${importanceOf(entry)}; updatedAt: ${entry.updatedAt}`,
		`description: ${cell(entry.description)}`,
	];
	if (origin) header.push(`origin: ${origin}`);
	if (entry.triggers?.length) header.push(`triggers: ${JSON.stringify(entry.triggers.map((item) => cell(item, 80)))}`);
	return `${header.join("\n")}\n---\n${safeText(entry.content)}`;
}

export function createMemoryGetToolDefinition(
	_cwd: string,
	options?: MemoryToolOptions,
): BusinessToolDefinition<typeof memoryGetSchema, MemoryToolDetails> {
	const ops = options?.operations ?? unavailableOperations;
	return {
		name: "memory_get",
		label: "memory_get",
		description: `Read the full text of memories by id (one id, or up to ${GET_MAX_IDS} in ids), using ids from memory_search or the recalled memory context. Cross-project and pending-quarantine entries are readable on demand and labeled with their origin. Archived memories are not returned; an unknown id is reported as not found instead of failing. Read-only.`,
		promptSnippet: loadSystemPrompt("tools/memory-get/snippet.md"),
		parameters: memoryGetSchema,
		executionMode: "parallel",
		async execute(_toolCallId, { id, ids }: MemoryGetToolInput, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const loaded = loadVisibleEntries(ops);
			if ("failure" in loaded) return loaded.failure;
			const requested = [...new Set([...(id ? [id] : []), ...(ids ?? [])].map((item) => item.trim()))].filter(
				Boolean,
			);
			if (requested.length === 0) {
				return textResult("请提供 id 或 ids（来自 memory_search 的结果）。", { mode: "get", returned: 0 });
			}
			const byId = new Map(
				loaded.entries.map((entry) => [entry.id, { entry, origin: undefined as string | undefined }]),
			);
			for (const cross of loaded.cross) {
				if (byId.has(cross.id)) continue;
				byId.set(cross.id, {
					entry: {
						id: cross.id,
						name: cross.name,
						description: cross.description,
						type: cross.type,
						scope: cross.scope === "pending" ? "workspace" : cross.scope,
						content: cross.content,
						createdAt: cross.createdAt,
						updatedAt: cross.updatedAt,
						filePath: cross.sourcePath,
						importance: cross.importance,
						triggers: cross.triggers,
						workspaceId: cross.workspaceId,
						sessionId: cross.sessionId,
					},
					origin: crossScopeLabel(cross),
				});
			}
			const sections: string[] = [];
			const found: string[] = [];
			for (const item of requested.slice(0, GET_MAX_IDS)) {
				const hit = isSafeMemoryId(item) ? byId.get(item) : undefined;
				if (hit) {
					sections.push(formatMemory(hit.entry, hit.origin));
					found.push(hit.entry.id);
				} else if (!isSafeMemoryId(item)) {
					sections.push(
						`无效的记忆 id：${cell(item, 80)}（格式应为 global/xxx、workspace/xxx、session/xxx 或 pending/xxx）`,
					);
				} else {
					sections.push(`未找到记忆：${item}（只能读取可见且未归档的记忆；用 memory_search 查看目录）`);
				}
			}
			if (requested.length > GET_MAX_IDS) {
				sections.push(`[一次最多读取 ${GET_MAX_IDS} 条，其余 ${requested.length - GET_MAX_IDS} 个 id 未读取。]`);
			}
			return textResult(sections.join("\n\n"), {
				mode: "get",
				total: requested.length,
				returned: found.length,
				ids: found,
			});
		},
	};
}

export function createMemorySearchTool(cwd: string, options?: MemoryToolOptions): AgentTool<typeof memorySearchSchema> {
	return wrapToolDefinition(createMemorySearchToolDefinition(cwd, options));
}

export function createMemoryGetTool(cwd: string, options?: MemoryToolOptions): AgentTool<typeof memoryGetSchema> {
	return wrapToolDefinition(createMemoryGetToolDefinition(cwd, options));
}
