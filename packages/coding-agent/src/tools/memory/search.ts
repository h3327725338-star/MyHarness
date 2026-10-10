import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import {
	isSafeMemoryId,
	type MemoryEntry,
	type MemoryScope,
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
}

export interface MemoryToolOptions {
	operations?: MemoryToolOperations;
}

const unavailableOperations: MemoryToolOperations = { loadEntries: () => undefined };

/** Memory access for a live session: its own Data root, workspace and conversation, gated by the Auto Memory setting. */
export function createSessionMemoryOperations(source: {
	sessionManager: Pick<SessionManager, "isPersisted" | "getDataRoot" | "getWorkspaceId" | "getSessionId">;
	settingsManager: Pick<SettingsManager, "getAutoMemorySettings">;
}): MemoryToolOperations {
	return {
		loadEntries() {
			const { sessionManager, settingsManager } = source;
			if (!sessionManager.isPersisted() || !settingsManager.getAutoMemorySettings().enabled) return undefined;
			const paths = getMemoryPaths({
				dataRoot: sessionManager.getDataRoot() ?? getDataDir(),
				workspaceId: sessionManager.getWorkspaceId() ?? UNBOUND_WORKSPACE_ID,
				sessionId: sessionManager.getSessionId(),
			});
			return readMemoryEntries({
				globalDir: paths.globalDir,
				projectDir: paths.workspaceDir,
				sessionDir: paths.sessionDir,
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
): { entries: MemoryEntry[] } | { failure: ReturnType<typeof textResult> } {
	try {
		const entries = ops.loadEntries();
		if (!entries) return { failure: textResult(DISABLED_TEXT, { mode: "disabled" }) };
		return { entries };
	} catch (error) {
		return { failure: textResult(`记忆读取失败：${cell(describeError(error))}`, { mode: "error" }) };
	}
}

function formatDirectory(entries: MemoryEntry[], limit: number | undefined): ReturnType<typeof textResult> {
	const sorted = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const header = "id | name | description | importance | type | scope | updatedAt";
	const rows: string[] = [];
	let bytes = Buffer.byteLength(header, "utf8");
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
		].join(" | ");
		const rowBytes = Buffer.byteLength(row, "utf8") + 1;
		if (rows.length > 0 && bytes + rowBytes > DIRECTORY_MAX_BYTES) break;
		rows.push(row);
		bytes += rowBytes;
	}
	const truncated = rows.length < sorted.length;
	const lines = [`记忆目录：共 ${sorted.length} 条，按更新时间由新到旧。用 memory_get 读取全文。`, header, ...rows];
	if (truncated) {
		lines.push(`[已截断：只列出前 ${rows.length} 条，共 ${sorted.length} 条。带 query 调用可缩小范围。]`);
	}
	if (sorted.length === 0) lines.push("（当前没有可见的记忆。）");
	return textResult(lines.join("\n"), {
		mode: "directory",
		total: sorted.length,
		returned: rows.length,
		ids: sorted.slice(0, rows.length).map((entry) => entry.id),
		truncated,
	});
}

function formatSearch(
	query: string,
	entries: MemoryEntry[],
	limit: number,
	scope: MemoryScope | undefined,
): ReturnType<typeof textResult> {
	const results = selectMemoriesForQuery(query, entries, { limit, scope });
	const ids = results.map(({ entry }) => entry.id);
	if (results.length === 0) {
		return textResult("没有匹配的记忆。不带 query 调用 memory_search 可以查看完整目录。", {
			mode: "search",
			total: entries.length,
			returned: 0,
			ids,
		});
	}
	const lines = [`找到 ${results.length} 条相关记忆（摘要，不含全文；用 memory_get 读取全文）：`];
	results.forEach(({ entry, via }, index) => {
		const excerpt = cell(entry.content, EXCERPT_MAX_CHARS);
		lines.push(
			`${index + 1}. ${entry.id} | ${cell(entry.name, 120)} | ${importanceOf(entry)} | ${entry.type} | ${entry.scope} | ${entry.updatedAt} | 命中：${via === "trigger" ? "触发词" : "关键词"}`,
			`   说明：${cell(entry.description)}`,
			`   摘录：${excerpt}`,
		);
	});
	return textResult(lines.join("\n"), { mode: "search", total: entries.length, returned: results.length, ids });
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
			"Search the long-term memory visible to this conversation (global, this workspace, this conversation). Without a query it lists the memory directory: id, name, description, importance, type, scope and update time, newest first. With a query it ranks memories exactly as automatic recall does and returns short summaries, not full text; use memory_get for the full text. The resident user profile (global/用户画像) is sent with every message and is not part of query results. Read-only.",
		promptSnippet: loadSystemPrompt("tools/memory-search/snippet.md"),
		parameters: memorySearchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, { query, limit, scope }: MemorySearchToolInput, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const loaded = loadVisibleEntries(ops);
			if ("failure" in loaded) return loaded.failure;
			const scoped = scope ? loaded.entries.filter((entry) => entry.scope === scope) : loaded.entries;
			const requested = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : undefined;
			const bounded = requested === undefined ? undefined : Math.min(SEARCH_MAX_LIMIT, Math.max(1, requested));
			if (!query?.trim()) return formatDirectory(scoped, bounded);
			return formatSearch(query, loaded.entries, bounded ?? SEARCH_DEFAULT_LIMIT, scope);
		},
	};
}

function formatMemory(entry: MemoryEntry): string {
	const header = [
		`=== ${entry.id} ===`,
		`name: ${cell(entry.name, 200)}`,
		`type: ${entry.type}; scope: ${entry.scope}; importance: ${importanceOf(entry)}; updatedAt: ${entry.updatedAt}`,
		`description: ${cell(entry.description)}`,
	];
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
		description: `Read the full text of memories by id (one id, or up to ${GET_MAX_IDS} in ids), using ids from memory_search or the recalled memory context. Returns the body and key metadata. Archived memories are not returned; an unknown id is reported as not found instead of failing. Read-only.`,
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
			const byId = new Map(loaded.entries.map((entry) => [entry.id, entry]));
			const sections: string[] = [];
			const found: string[] = [];
			for (const item of requested.slice(0, GET_MAX_IDS)) {
				const entry = isSafeMemoryId(item) ? byId.get(item) : undefined;
				if (entry) {
					sections.push(formatMemory(entry));
					found.push(entry.id);
				} else if (!isSafeMemoryId(item)) {
					sections.push(`无效的记忆 id：${cell(item, 80)}（格式应为 global/xxx、workspace/xxx 或 session/xxx）`);
				} else {
					sections.push(`未找到记忆：${item}（只能读取当前对话可见且未归档的记忆；用 memory_search 查看目录）`);
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
