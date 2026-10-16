import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAutoMemoryPaths, MEMORY_PROFILE_ID, readMemoryEntries } from "../src/agent/runtime/auto-memory.ts";
import { DELEGATED_TOOL_NAMES } from "../src/agent/runtime/role.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { getMemoryPaths } from "../src/session/memory/store.ts";
import { createSessionMemoryManageOperations } from "../src/tools/memory/manage.ts";
import { createMemoryWriteToolDefinition } from "../src/tools/memory/write.ts";
import { allToolNames, createAllToolDefinitions, createAllTools } from "../src/tools/registry.ts";

const testRoot = join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-memory-write-tests");
const dataRoot = join(testRoot, "data");
const agentDir = join(testRoot, "agent");
const projectDir = join(testRoot, "project");
const location = { dataRoot, workspaceId: "ws", sessionId: "session-one" };

const enabledSettings = () =>
	SettingsManager.inMemory({
		autoMemory: { enabled: true, provider: "test", model: "memory-model", thinkingLevel: "high" },
	});

function manageOperations() {
	return createSessionMemoryManageOperations({
		sessionManager: {
			isPersisted: () => true,
			getDataRoot: () => dataRoot,
			getWorkspaceId: () => location.workspaceId,
			getSessionId: () => location.sessionId,
		},
		settingsManager: enabledSettings(),
	});
}

const writer = () => createMemoryWriteToolDefinition(projectDir, { operations: manageOperations() });
const run = <T extends { execute: (...args: any[]) => Promise<any> }>(tool: T, input: object) =>
	tool.execute("call", input, undefined, undefined, undefined);

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function liveEntries() {
	return readMemoryEntries(getAutoMemoryPaths(projectDir, agentDir, location));
}

function readState() {
	const file = join(dataRoot, "memory", "state.json");
	return JSON.parse(readFileSync(file, "utf8")) as {
		consolidation: Record<string, { pendingChanges?: number; pendingSince?: string; revision?: number }>;
	};
}

describe("memory_write", () => {
	afterEach(() => {
		rmSync(testRoot, { recursive: true, force: true });
	});

	it("creates memories in all three layers and records consolidation bookkeeping", async () => {
		const result = await run(writer(), {
			items: [
				{
					scope: "global",
					type: "feedback",
					name: "Global Habit",
					description: "全局习惯相关时",
					content: "先给结论再讲原因。",
				},
				{
					scope: "workspace",
					type: "project",
					name: "Workspace Deploy",
					description: "发布流程相关时",
					content: "发布前先跑完整测试。",
				},
				{
					scope: "session",
					type: "reference",
					name: "Session Note",
					description: "本轮对话相关时",
					content: "这次要对比三个方案。",
				},
			],
		});
		expect(result.details).toMatchObject({ mode: "write", total: 3, returned: 3 });
		const ids = (result.details as { ids: string[] }).ids;
		expect(ids).toEqual(["global/global-habit", "workspace/workspace-deploy", "session/session-note"]);

		const byId = new Map(liveEntries().map((entry) => [entry.id, entry]));
		expect(byId.get("global/global-habit")?.content).toContain("先给结论");
		expect(byId.get("workspace/workspace-deploy")?.content).toContain("发布前");
		expect(byId.get("session/session-note")?.content).toContain("三个方案");

		const paths = getMemoryPaths(location);
		expect(existsSync(join(paths.globalDir, "global-habit.md"))).toBe(true);
		expect(existsSync(join(paths.workspaceDir, "workspace-deploy.md"))).toBe(true);
		expect(existsSync(join(paths.sessionDir, "session-note.md"))).toBe(true);

		const state = readState().consolidation[location.workspaceId];
		expect(state.pendingChanges).toBeGreaterThanOrEqual(3);
		expect(typeof state.pendingSince).toBe("string");
		expect(state.revision).toBeGreaterThanOrEqual(1);
	});

	it("creates the resident profile on first write with an explicit id", async () => {
		const result = await run(writer(), {
			items: [
				{
					id: MEMORY_PROFILE_ID,
					scope: "global",
					type: "user",
					name: "用户画像",
					description: "常驻画像",
					content: "说人话，结论先行。",
				},
			],
		});
		expect(toolText(result)).toContain("已创建用户画像");
		expect((result.details as { ids: string[] }).ids).toEqual([MEMORY_PROFILE_ID]);
		expect(liveEntries().find((entry) => entry.id === MEMORY_PROFILE_ID)?.content).toContain("说人话");
	});

	it("updates an existing memory, archives the old version and refreshes the indexes", async () => {
		await run(writer(), {
			items: [
				{
					scope: "global",
					type: "feedback",
					name: "Plain Talk",
					description: "沟通时相关",
					content: "用户要求说人话。",
				},
			],
		});
		const updated = await run(writer(), {
			items: [
				{
					id: "global/plain-talk",
					scope: "global",
					type: "feedback",
					name: "Plain Talk",
					description: "沟通时相关",
					content: "用户要求说人话，并且先给结论。",
				},
			],
		});
		expect(toolText(updated)).toContain("已更新");
		expect(toolText(updated)).toContain("旧版已归档");

		const paths = getMemoryPaths(location);
		expect(readFileSync(join(paths.globalDir, "plain-talk.md"), "utf8")).toContain("先给结论");
		const archiveDir = join(paths.globalDir, "archive");
		const archived = readdirSync(archiveDir).filter((name) => name.startsWith("plain-talk-"));
		expect(archived).toHaveLength(1);
		expect(readFileSync(join(archiveDir, archived[0]), "utf8")).toContain("用户要求说人话");

		const index = JSON.parse(readFileSync(join(dataRoot, "memory", "index.json"), "utf8")) as {
			entries: Array<{ id: string }>;
		};
		expect(index.entries.some((entry) => entry.id === "global/plain-talk")).toBe(true);
	});

	it("suffixes colliding generated ids instead of overwriting", async () => {
		for (let round = 0; round < 2; round++) {
			await run(writer(), {
				items: [
					{
						scope: "workspace",
						type: "project",
						name: "Same Name",
						description: "第几次都相关",
						content: `第 ${round} 次内容。`,
					},
				],
			});
		}
		const byId = new Map(liveEntries().map((entry) => [entry.id, entry]));
		expect(byId.has("workspace/same-name")).toBe(true);
		expect(byId.has("workspace/same-name-2")).toBe(true);
		expect(byId.get("workspace/same-name-2")?.content).toContain("第 1 次内容");
	});

	it("rejects overlong content without truncating and keeps the other items", async () => {
		const huge = "长".repeat(5000); // 15,000 bytes > 10KB
		const result = await run(writer(), {
			items: [
				{ scope: "global", type: "feedback", name: "Too Long", description: "太长时", content: huge },
				{
					scope: "global",
					type: "feedback",
					name: "Short One",
					description: "短时",
					content: "短内容。",
				},
			],
		});
		const text = toolText(result);
		expect(text).toContain("拆成多条写入");
		expect(text).toContain("已记住");
		expect(result.details).toMatchObject({ mode: "write", total: 2, returned: 1 });
		expect(liveEntries().some((entry) => entry.id === "global/too-long")).toBe(false);
		expect(liveEntries().some((entry) => entry.id === "global/short-one")).toBe(true);
	});

	it("redacts sensitive values instead of storing them", async () => {
		await run(writer(), {
			items: [
				{
					scope: "global",
					type: "feedback",
					name: "Secret Note",
					description: "密钥相关时",
					content: "部署密码 password=hunter2-value 用完即焚。",
				},
			],
		});
		const paths = getMemoryPaths(location);
		const stored = readFileSync(join(paths.globalDir, "secret-note.md"), "utf8");
		expect(stored).not.toContain("hunter2-value");
		expect(stored).toContain("[已移除敏感值]");
	});

	it("fails unknown, unsafe and scope-mismatched ids with a hint to omit id for creation", async () => {
		const unknownId = toolText(
			await run(writer(), {
				items: [
					{
						id: "global/no-such-thing",
						scope: "global",
						type: "feedback",
						name: "Ghost",
						description: "不存在时",
						content: "幽灵内容。",
					},
				],
			}),
		);
		expect(unknownId).toContain("未找到记忆");
		expect(unknownId).toContain("新建请省略 id");

		const unsafe = toolText(
			await run(writer(), {
				items: [
					{ id: "../evil", scope: "global", type: "feedback", name: "Evil", description: "非法时", content: "x" },
				],
			}),
		);
		expect(unsafe).toContain("无效的记忆 id");

		const mismatched = toolText(
			await run(writer(), {
				items: [
					{
						id: "global/plain-talk",
						scope: "workspace",
						type: "feedback",
						name: "Plain Talk",
						description: "错层时",
						content: "内容。",
					},
				],
			}),
		);
		expect(mismatched).toContain("前缀应为 workspace/");
	});

	it("rejects an invalid importance without touching storage", async () => {
		const result = await run(writer(), {
			items: [
				{
					scope: "global",
					type: "feedback",
					name: "Bad Importance",
					description: "非法标注时",
					content: "内容。",
					// "urgent" cannot happen through schema-validated calls; it exercises the in-tool guard.
					importance: "urgent" as "high",
				},
			],
		});
		expect(toolText(result)).toContain("importance 非法");
		expect(result.details).toMatchObject({ returned: 0 });
		expect(liveEntries()).toHaveLength(0);
	});

	it("processes at most 10 items and reports the unprocessed rest", async () => {
		const items = Array.from({ length: 12 }, (_, index) => ({
			scope: "global" as const,
			type: "feedback" as const,
			name: `Bulk ${index}`,
			description: "批量时",
			content: `批量内容 ${index}。`,
		}));
		const result = await run(writer(), { items });
		expect(result.details).toMatchObject({ mode: "write", total: 12, returned: 10 });
		expect(toolText(result)).toContain("其余 2 条未处理");
		expect(liveEntries()).toHaveLength(10);
	});

	it("reports failures per item while the rest succeed", async () => {
		const result = await run(writer(), {
			items: [
				{ scope: "global", type: "feedback", name: "Good One", description: "成功时", content: "好内容。" },
				{
					id: "global/ghost",
					scope: "global",
					type: "feedback",
					name: "Ghost",
					description: "失败时",
					content: "幽灵内容。",
				},
				{ scope: "global", type: "feedback", name: "Too Long", description: "太长时", content: "长".repeat(5000) },
			],
		});
		const text = toolText(result);
		expect(text).toContain("已记住");
		expect(text).toContain("未找到记忆");
		expect(text).toContain("拆成多条写入");
		expect(result.details).toMatchObject({ mode: "write", total: 3, returned: 1 });
		expect((result.details as { ids: string[] }).ids).toEqual(["global/good-one"]);
	});

	it("explains that Auto Memory is off without touching storage", async () => {
		const fallback = await run(writer(), { items: [] });
		expect(fallback.details).toMatchObject({ mode: "write" });

		const unconfigured = createMemoryWriteToolDefinition(projectDir);
		const disabled = await run(unconfigured, {
			items: [{ scope: "global", type: "feedback", name: "X", description: "Y", content: "Z" }],
		});
		expect(disabled.details).toMatchObject({ mode: "disabled" });
		expect(toolText(disabled)).toContain("Auto Memory 未启用");

		const ephemeral = createMemoryWriteToolDefinition(projectDir, {
			operations: createSessionMemoryManageOperations({
				sessionManager: {
					isPersisted: () => false,
					getDataRoot: () => dataRoot,
					getWorkspaceId: () => location.workspaceId,
					getSessionId: () => location.sessionId,
				},
				settingsManager: enabledSettings(),
			}),
		});
		const ephemeralResult = await run(ephemeral, {
			items: [{ scope: "global", type: "feedback", name: "X", description: "Y", content: "Z" }],
		});
		expect(ephemeralResult.details).toMatchObject({ mode: "disabled" });
		expect(toolText(ephemeralResult)).toContain("Auto Memory 未启用");
		expect(liveEntries()).toHaveLength(0);
	});

	it("is registered for the main agent but not for delegated sessions", () => {
		expect(allToolNames.has("memory_write")).toBe(true);
		const definitions = createAllToolDefinitions(projectDir);
		expect(definitions.memory_write.executionMode).toBe("sequential");
		expect(definitions.memory_write.promptSnippet).toContain("memory_delete");
		expect(createAllTools(projectDir).memory_write.name).toBe("memory_write");
		expect((DELEGATED_TOOL_NAMES as readonly string[]).includes("memory_write")).toBe(false);
	});
});
