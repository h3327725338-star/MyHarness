import { relative } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { isSafeMemoryId, readCrossScopeMemoryEntries, readMemoryEntries } from "../../agent/runtime/auto-memory.ts";
import { getDataDir, UNBOUND_WORKSPACE_ID } from "../../config/paths/index.ts";
import type { SettingsManager } from "../../config/settings/index.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { claimPendingMemory, deleteMemoryPermanently, getMemoryPaths } from "../../session/memory/store.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import type { MemoryToolOptions } from "./search.ts";

const MANAGE_MAX_IDS = 5;
const DISABLED_TEXT = "Auto Memory 未启用（已在设置中关闭，或当前会话不保存记忆），记忆工具不可用。";

const memoryDeleteSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Memory id to permanently delete, for example global/some-memory." })),
	ids: Type.Optional(
		Type.Array(Type.String(), { description: `Several memory ids at once (at most ${MANAGE_MAX_IDS}).` }),
	),
});

const memoryClaimSchema = Type.Object({
	id: Type.String({ description: "Pending memory id to claim into the current workspace, for example pending/xxx." }),
});

export type MemoryDeleteToolInput = Static<typeof memoryDeleteSchema>;
export type MemoryClaimToolInput = Static<typeof memoryClaimSchema>;

export interface MemoryManageToolDetails {
	mode: "disabled" | "delete" | "claim" | "error";
	total?: number;
	returned?: number;
	ids?: string[];
}

export interface MemoryManageContext {
	dataRoot: string;
	workspaceId: string;
	sessionId: string;
}

/**
 * Pluggable read/write access to one conversation's memories. The default has none, which reads as
 * "Auto Memory is off". Delete is limited to this conversation's own three layers plus the pending
 * quarantine; memories owned by other workspaces or conversations cannot be deleted from here.
 * Claim only moves pending-quarantine entries into the current workspace.
 */
export interface MemoryManageOperations {
	context: () => MemoryManageContext | undefined;
}

const unavailableOperations: MemoryManageOperations = { context: () => undefined };

function resolveManageOperations(options?: MemoryManageOptions | MemoryToolOptions): MemoryManageOperations {
	const direct = (options as MemoryManageOptions | undefined)?.operations;
	if (direct && typeof (direct as Partial<MemoryManageOperations>).context === "function") {
		return direct as MemoryManageOperations;
	}
	return (options as MemoryToolOptions | undefined)?.manageOperations ?? unavailableOperations;
}

/** Manage access for a live session, gated by the Auto Memory setting like the read tools. */
export function createSessionMemoryManageOperations(source: {
	sessionManager: Pick<SessionManager, "isPersisted" | "getDataRoot" | "getWorkspaceId" | "getSessionId">;
	settingsManager: Pick<SettingsManager, "getAutoMemorySettings">;
}): MemoryManageOperations {
	return {
		context() {
			const { sessionManager, settingsManager } = source;
			if (!sessionManager.isPersisted() || !settingsManager.getAutoMemorySettings().enabled) return undefined;
			return {
				dataRoot: sessionManager.getDataRoot() ?? getDataDir(),
				workspaceId: sessionManager.getWorkspaceId() ?? UNBOUND_WORKSPACE_ID,
				sessionId: sessionManager.getSessionId(),
			};
		},
	};
}

export interface MemoryManageOptions {
	operations?: MemoryManageOperations;
}

function textResult(text: string, details: MemoryManageToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

/** Resolve an id to a dataRoot-relative file path when this conversation may delete it. */
function resolveDeletablePath(
	id: string,
	context: MemoryManageContext,
): { relativePath: string } | { refusal: string } {
	const paths = getMemoryPaths({
		dataRoot: context.dataRoot,
		workspaceId: context.workspaceId,
		sessionId: context.sessionId,
	});
	const own = readMemoryEntries({
		globalDir: paths.globalDir,
		projectDir: paths.workspaceDir,
		sessionDir: paths.sessionDir,
	});
	const hit = own.find((entry) => entry.id === id);
	if (hit) return { relativePath: relative(context.dataRoot, hit.filePath).replace(/\\/g, "/") };
	const cross = readCrossScopeMemoryEntries(context.dataRoot, {
		workspaceId: context.workspaceId,
		sessionId: context.sessionId,
	});
	const pending = cross.find((entry) => entry.kind === "pending" && entry.id === id);
	if (pending) return { relativePath: relative(context.dataRoot, pending.sourcePath).replace(/\\/g, "/") };
	if (cross.some((entry) => entry.id === id))
		return { refusal: `不能删除：${id} 属于其他项目或对话，只能删除本轮可见范围和待认领区的记忆。` };
	return { refusal: `未找到记忆：${id}（只能删除本轮可见且未归档的记忆；用 memory_search 查看目录）` };
}

export function createMemoryDeleteToolDefinition(
	_cwd: string,
	options?: MemoryManageOptions | MemoryToolOptions,
): BusinessToolDefinition<typeof memoryDeleteSchema, MemoryManageToolDetails> {
	const ops = resolveManageOperations(options);
	return {
		name: "memory_delete",
		label: "memory_delete",
		description:
			"Permanently delete long-term memories by id (own three layers plus the pending quarantine only; other projects' memories cannot be deleted from here). Archived versions of a deleted memory are removed as well and nothing can be recovered. Use only when the user explicitly asks to forget something.",
		promptSnippet: loadSystemPrompt("tools/memory-delete/snippet.md"),
		parameters: memoryDeleteSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { id, ids }: MemoryDeleteToolInput, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const context = ops.context();
			if (!context) return textResult(DISABLED_TEXT, { mode: "disabled" });
			const requested = [...new Set([...(id ? [id] : []), ...(ids ?? [])].map((item) => item.trim()))].filter(
				Boolean,
			);
			if (requested.length === 0) {
				return textResult("请提供 id 或 ids（来自 memory_search 的结果）。", { mode: "delete", returned: 0 });
			}
			const sections: string[] = [];
			const deleted: string[] = [];
			for (const item of requested.slice(0, MANAGE_MAX_IDS)) {
				if (!isSafeMemoryId(item)) {
					sections.push(
						`无效的记忆 id：${item}（格式应为 global/xxx、workspace/xxx、session/xxx 或 pending/xxx）`,
					);
					continue;
				}
				const resolved = resolveDeletablePath(item, context);
				if ("refusal" in resolved) {
					sections.push(resolved.refusal);
					continue;
				}
				try {
					const { archiveCount } = await deleteMemoryPermanently(context.dataRoot, resolved.relativePath);
					sections.push(
						`已彻底删除：${item}${archiveCount > 0 ? `（连带清除 ${archiveCount} 个归档版本）` : ""}，不可恢复。`,
					);
					deleted.push(item);
				} catch (error) {
					sections.push(`删除失败：${item}（${error instanceof Error ? error.message : String(error)}）`);
				}
			}
			if (requested.length > MANAGE_MAX_IDS) {
				sections.push(
					`[一次最多删除 ${MANAGE_MAX_IDS} 条，其余 ${requested.length - MANAGE_MAX_IDS} 个 id 未处理。]`,
				);
			}
			return textResult(sections.join("\n"), {
				mode: "delete",
				total: requested.length,
				returned: deleted.length,
				ids: deleted,
			});
		},
	};
}

export function createMemoryClaimToolDefinition(
	_cwd: string,
	options?: MemoryManageOptions | MemoryToolOptions,
): BusinessToolDefinition<typeof memoryClaimSchema, MemoryManageToolDetails> {
	const ops = resolveManageOperations(options);
	return {
		name: "memory_claim",
		label: "memory_claim",
		description:
			"Claim one pending-quarantine memory into the current workspace so it becomes a normal workspace memory. Only pending/xxx ids are accepted. Use when the user confirms a quarantined memory belongs to this project.",
		promptSnippet: loadSystemPrompt("tools/memory-claim/snippet.md"),
		parameters: memoryClaimSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { id }: MemoryClaimToolInput, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const context = ops.context();
			if (!context) return textResult(DISABLED_TEXT, { mode: "disabled" });
			const trimmed = id?.trim() ?? "";
			if (!trimmed || !isSafeMemoryId(trimmed)) {
				return textResult("请提供待认领记忆的 id（来自 memory_search 的结果，pending/ 开头）。", {
					mode: "claim",
					returned: 0,
				});
			}
			const cross = readCrossScopeMemoryEntries(context.dataRoot, {
				workspaceId: context.workspaceId,
				sessionId: context.sessionId,
			});
			const pending = cross.find((entry) => entry.kind === "pending" && entry.id === trimmed);
			if (!pending) {
				return textResult(`未找到待认领记忆：${trimmed}（只能认领待认领区的记忆；用 memory_search 查看目录）。`, {
					mode: "claim",
					returned: 0,
				});
			}
			try {
				const { id: newId } = await claimPendingMemory(
					context.dataRoot,
					relative(context.dataRoot, pending.sourcePath).replace(/\\/g, "/"),
					context.workspaceId,
				);
				return textResult(`已认领为当前工作区记忆：${newId}（原 ${trimmed} 已移出待认领区）。`, {
					mode: "claim",
					total: 1,
					returned: 1,
					ids: [newId],
				});
			} catch (error) {
				return textResult(`认领失败：${trimmed}（${error instanceof Error ? error.message : String(error)}）`, {
					mode: "claim",
					returned: 0,
				});
			}
		},
	};
}

export function createMemoryDeleteTool(
	cwd: string,
	options?: MemoryManageOptions | MemoryToolOptions,
): AgentTool<typeof memoryDeleteSchema> {
	return wrapToolDefinition(createMemoryDeleteToolDefinition(cwd, options));
}

export function createMemoryClaimTool(
	cwd: string,
	options?: MemoryManageOptions | MemoryToolOptions,
): AgentTool<typeof memoryClaimSchema> {
	return wrapToolDefinition(createMemoryClaimToolDefinition(cwd, options));
}
