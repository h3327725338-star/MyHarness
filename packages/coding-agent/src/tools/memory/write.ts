import * as fs from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import {
	isMemoryProfile,
	isSafeMemoryId,
	MEMORY_BODY_MAX_BYTES,
	MEMORY_PROFILE_ID,
	MEMORY_TYPES,
	type MemoryEntry,
	type MemoryScope,
	normalizeTriggers,
	readImportance,
	readMemoryEntries,
	sanitizeMemoryText,
	serializeMemory,
	slugify,
} from "../../agent/runtime/auto-memory.ts";
import {
	archiveMemoryFile,
	getMemoryPaths,
	recordMemoryWriteConsolidation,
	refreshMemoryIndexes,
	withMemoryLock,
	writeMemoryFile,
} from "../../session/memory/store.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import type { MemoryManageOperations, MemoryManageOptions } from "./manage.ts";
import type { MemoryToolOptions } from "./search.ts";

const MEMORY_WRITE_MAX_ITEMS = 10;
const DISABLED_TEXT = "Auto Memory 未启用（已在设置中关闭，或当前会话不保存记忆），记忆工具不可用。";

const memoryWriteItemSchema = Type.Object({
	id: Type.Optional(
		Type.String({
			description:
				"Existing memory id to update (from memory_search), for example global/some-memory. Omit it to create a new memory. Only global/用户画像 may be created with an explicit id.",
		}),
	),
	scope: Type.Union([Type.Literal("global"), Type.Literal("workspace"), Type.Literal("session")], {
		description: "Where to store the memory.",
	}),
	type: Type.Union(
		[Type.Literal("user"), Type.Literal("feedback"), Type.Literal("project"), Type.Literal("reference")],
		{ description: "Kind of memory." },
	),
	name: Type.String({ description: "Short title of the memory." }),
	description: Type.String({ description: "One-line summary of when this memory applies." }),
	content: Type.String({
		description: "Full memory text (at most 10KB of UTF-8; split longer text into several items).",
	}),
	importance: Type.Optional(
		Type.Union([Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")], {
			description: "Recall ranking weight; omit it to keep the stored value when updating.",
		}),
	),
	triggers: Type.Optional(
		Type.Array(Type.String(), {
			description: "Phrases the user really says that should recall this memory (at most 6 are kept).",
		}),
	),
});

const memoryWriteSchema = Type.Object({
	items: Type.Array(memoryWriteItemSchema, {
		description: `Memories to create or update (at most ${MEMORY_WRITE_MAX_ITEMS} per call; the rest are left unprocessed).`,
	}),
});

export type MemoryWriteToolItem = Static<typeof memoryWriteItemSchema>;
export type MemoryWriteToolInput = Static<typeof memoryWriteSchema>;

export interface MemoryWriteToolDetails {
	mode: "disabled" | "write" | "error";
	total?: number;
	returned?: number;
	ids?: string[];
}

interface MemoryWriteContext {
	dataRoot: string;
	workspaceId: string;
	sessionId: string;
}

const unavailableOperations: MemoryManageOperations = { context: () => undefined };

function resolveWriteOperations(options?: MemoryManageOptions | MemoryToolOptions): MemoryManageOperations {
	const direct = (options as MemoryManageOptions | undefined)?.operations;
	if (direct && typeof (direct as Partial<MemoryManageOperations>).context === "function") {
		return direct as MemoryManageOperations;
	}
	return (options as MemoryToolOptions | undefined)?.manageOperations ?? unavailableOperations;
}

function textResult(text: string, details: MemoryWriteToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function scopeDirectory(
	scope: "global" | "workspace" | "session",
	paths: { globalDir: string; workspaceDir: string; sessionDir: string },
): string {
	return scope === "global" ? paths.globalDir : scope === "session" ? paths.sessionDir : paths.workspaceDir;
}

export function createMemoryWriteToolDefinition(
	_cwd: string,
	options?: MemoryManageOptions | MemoryToolOptions,
): BusinessToolDefinition<typeof memoryWriteSchema, MemoryWriteToolDetails> {
	const ops = resolveWriteOperations(options);
	return {
		name: "memory_write",
		label: "memory_write",
		description:
			"Create or update long-term memories (own three layers only) when the user explicitly asks to remember, import, correct or update something, including the resident user profile (global/用户画像). Omit id to create; pass an existing id from memory_search to update it (the previous version is archived). Only global/用户画像 may be created with an explicit id; anything else with an unknown id is rejected. Content over 10KB is rejected, never truncated. Forgetting is done with memory_delete, never here.",
		promptSnippet: loadSystemPrompt("tools/memory-write/snippet.md"),
		parameters: memoryWriteSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { items }: MemoryWriteToolInput, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const context = ops.context();
			if (!context) return textResult(DISABLED_TEXT, { mode: "disabled" });
			const list = Array.isArray(items) ? items : [];
			if (list.length === 0) {
				return textResult("请提供 items（至少一条要记住、导入或更正的内容）。", { mode: "write", returned: 0 });
			}
			const overflow = list.length > MEMORY_WRITE_MAX_ITEMS ? list.length - MEMORY_WRITE_MAX_ITEMS : 0;
			const batch = list.slice(0, MEMORY_WRITE_MAX_ITEMS);
			let outcome: { sections: string[]; written: string[] };
			try {
				outcome = await withMemoryLock(context.dataRoot, () => applyMemoryWrites(context, batch));
			} catch (error) {
				return textResult(
					`记忆写入失败：${error instanceof Error ? error.message : String(error)}（稍后重试；如果是锁竞争，等十几秒再试一次）。`,
					{ mode: "error" },
				);
			}
			if (overflow > 0) {
				outcome.sections.push(
					`[一次最多写入 ${MEMORY_WRITE_MAX_ITEMS} 条，其余 ${overflow} 条未处理，请分多次调用。]`,
				);
			}
			return textResult(outcome.sections.join("\n"), {
				mode: "write",
				total: list.length,
				returned: outcome.written.length,
				ids: outcome.written,
			});
		},
	};
}

/** Write one batch inside the memory lock; refreshes indexes and records consolidation bookkeeping on success. */
async function applyMemoryWrites(
	context: MemoryWriteContext,
	batch: MemoryWriteToolItem[],
): Promise<{ sections: string[]; written: string[] }> {
	const paths = getMemoryPaths({
		dataRoot: context.dataRoot,
		workspaceId: context.workspaceId,
		sessionId: context.sessionId,
	});
	const existing = new Map(
		readMemoryEntries({
			globalDir: paths.globalDir,
			projectDir: paths.workspaceDir,
			sessionDir: paths.sessionDir,
		}).map((entry) => [entry.id, entry]),
	);
	const sections: string[] = [];
	const written: string[] = [];
	for (const item of batch) {
		const outcome = await applyMemoryWriteItem(context, paths, existing, item);
		sections.push(outcome.line);
		if (outcome.id) written.push(outcome.id);
	}
	if (written.length > 0) {
		await recordMemoryWriteConsolidation(context.dataRoot, context.workspaceId, written.length);
		await refreshMemoryIndexes(context.dataRoot);
	}
	return { sections, written };
}

async function applyMemoryWriteItem(
	context: MemoryWriteContext,
	paths: { globalDir: string; workspaceDir: string; sessionDir: string },
	existing: Map<string, MemoryEntry>,
	item: MemoryWriteToolItem,
): Promise<{ line: string; id?: string }> {
	const scope = (item as { scope?: unknown }).scope;
	if (scope !== "global" && scope !== "workspace" && scope !== "session") {
		return { line: "记忆 scope 非法：只能是 global、workspace 或 session。" };
	}
	const type = (item as { type?: unknown }).type;
	if (typeof type !== "string" || !MEMORY_TYPES.has(type as MemoryEntry["type"])) {
		return { line: "记忆 type 非法：只能是 user、feedback、project 或 reference。" };
	}
	const rawName = typeof item.name === "string" ? item.name : "";
	const rawDescription = typeof item.description === "string" ? item.description : "";
	const rawContent = typeof item.content === "string" ? item.content : "";
	if (!rawName.trim() || !rawDescription.trim() || !rawContent.trim()) {
		return { line: "缺少 name、description 或 content：三者都不能为空。" };
	}
	let name: string;
	let description: string;
	let content: string;
	try {
		name = sanitizeMemoryText(rawName).trim();
		description = sanitizeMemoryText(rawDescription).trim();
		content = sanitizeMemoryText(rawContent).trim();
	} catch (error) {
		return { line: `已拒绝保存：${error instanceof Error ? error.message : String(error)}` };
	}
	if (!name || !description || !content) {
		return { line: "缺少 name、description 或 content：清洗后不能为空。" };
	}
	if (Buffer.byteLength(content, "utf8") > MEMORY_BODY_MAX_BYTES) {
		return {
			line: `内容超过 ${(MEMORY_BODY_MAX_BYTES / 1024).toFixed(0)}KB 上限，已拒绝保存（不会截断）：请拆成多条写入。`,
		};
	}
	let importance: MemoryEntry["importance"];
	if (item.importance !== undefined) {
		const parsed = readImportance(item.importance);
		if (!parsed) return { line: "importance 非法：只能是 high、normal 或 low，不填则更新时保留原值。" };
		importance = parsed;
	}
	let triggers: string[] | undefined;
	try {
		const normalized = normalizeTriggers(item.triggers, sanitizeMemoryText);
		triggers = normalized.length > 0 ? normalized : undefined;
	} catch (error) {
		return { line: `triggers 非法：${error instanceof Error ? error.message : String(error)}` };
	}

	const rawId = typeof item.id === "string" ? item.id.trim() : "";
	let id: string;
	let previous: MemoryEntry | undefined;
	if (rawId) {
		if (!isSafeMemoryId(rawId)) {
			return {
				line: `无效的记忆 id：${rawId}（格式应为 global/xxx、workspace/xxx 或 session/xxx；新建请省略 id）。`,
			};
		}
		if (!rawId.startsWith(`${scope}/`)) {
			return { line: `id 与 scope 不一致：${rawId} 的前缀应为 ${scope}/。` };
		}
		previous = existing.get(rawId);
		if (!previous) {
			if (rawId !== MEMORY_PROFILE_ID) {
				return { line: `未找到记忆：${rawId}（新建请省略 id；只有 ${MEMORY_PROFILE_ID} 允许首次创建时指定 id）。` };
			}
			id = rawId;
		} else {
			id = rawId;
		}
	} else {
		const base = `${scope}/${slugify(name)}`;
		id = base;
		let suffix = 2;
		while (existing.has(id)) id = `${base}-${suffix++}`;
		previous = undefined;
	}
	if (!triggers) triggers = previous?.triggers;
	if (importance === undefined) importance = previous?.importance;

	const now = new Date().toISOString();
	const filePath = join(scopeDirectory(scope, paths), `${id.slice(scope.length + 1)}.md`);
	const entry: MemoryEntry = {
		id,
		name,
		description,
		type: type as MemoryEntry["type"],
		scope: scope as MemoryScope,
		content,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		filePath,
		importance,
		triggers,
		workspaceId: scope === "global" ? undefined : context.workspaceId,
		sessionId: scope === "session" ? context.sessionId : undefined,
		// An update keeps where the memory came from; a new memory came from this chat.
		sourceEntryId: previous?.sourceEntryId,
		sourceWorkspaceId: previous ? previous.sourceWorkspaceId : context.workspaceId,
		sourceSessionId: previous ? previous.sourceSessionId : context.sessionId,
		updatedBy: context.sessionId,
	};
	if (previous) await archiveMemoryFile(previous.filePath, "updated");
	await writeMemoryFile(filePath, serializeMemory(entry));
	if (previous && previous.filePath !== filePath) await fs.promises.unlink(previous.filePath);
	existing.set(id, entry);
	const profile = isMemoryProfile({ id, scope: scope as MemoryScope });
	if (!previous) {
		return { line: profile ? `已创建用户画像：${id}。` : `已记住：${id}（${scope} · ${type}）。`, id };
	}
	return { line: profile ? `已更新用户画像：${id}（旧版已归档）。` : `已更新：${id}（旧版已归档）。`, id };
}

export function createMemoryWriteTool(
	cwd: string,
	options?: MemoryManageOptions | MemoryToolOptions,
): AgentTool<typeof memoryWriteSchema> {
	return wrapToolDefinition(createMemoryWriteToolDefinition(cwd, options));
}
