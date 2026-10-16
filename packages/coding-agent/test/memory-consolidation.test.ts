import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AutoMemoryManager, MEMORY_PROFILE_ID } from "../src/agent/runtime/auto-memory.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { SessionEntry } from "../src/session/types.ts";

const roots: string[] = [];
const managers: AutoMemoryManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "consolidation-"));
	roots.push(root);
	let operations: unknown[] = [];
	let fail = false;
	const runner = vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
		if (systemPrompt.includes("merge duplicates")) return fail ? "invalid" : '{"operations":[]}';
		return JSON.stringify({ operations });
	});
	const options = {
		cwd: root,
		dataRoot: join(root, "data"),
		agentDir: join(root, "agent"),
		workspaceId: "workspace",
		sessionId: "one",
		persisted: true,
		settingsManager: SettingsManager.inMemory({ autoMemory: { enabled: true, provider: "test", model: "test" } }),
		modelRunner: runner,
	};
	const create = () => {
		const manager = new AutoMemoryManager(options);
		managers.push(manager);
		return manager;
	};
	const state = () =>
		JSON.parse(readFileSync(join(options.dataRoot, "memory/state.json"), "utf8")).consolidation.workspace;
	const change = (count: number) => {
		operations = Array.from({ length: count }, (_, i) => ({
			action: "upsert",
			scope: "workspace",
			type: "project",
			name: `item-${i}`,
			description: "test",
			content: `body-${i}`,
		}));
	};
	const entry = (id: string) =>
		[
			{ type: "message", id, message: { role: "user", content: "remember", timestamp: Date.now() } },
		] as unknown as SessionEntry[];
	return {
		create,
		state,
		change,
		entry,
		runner,
		dataRoot: options.dataRoot,
		fail: () => {
			fail = true;
		},
	};
}
it("consolidates immediately after five real changes in one conversation", async () => {
	const f = fixture();
	const m = f.create();
	f.change(5);
	expect(await m.runExtraction(f.entry("a"))).toBe(true);
	expect(f.runner).toHaveBeenCalledTimes(2);
	expect(f.state().pendingChanges).toBe(0);
});
it("does not count unchanged writes or reset the first-change time, and resumes after restart", async () => {
	vi.useFakeTimers();
	const f = fixture();
	let m = f.create();
	f.change(1);
	await m.runExtraction(f.entry("a"));
	const since = f.state().pendingSince;
	vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
	await m.runExtraction(f.entry("b"));
	expect(f.state().pendingChanges).toBe(1);
	expect(f.state().pendingSince).toBe(since);
	m.dispose();
	vi.setSystemTime(Date.now() + 60 * 60 * 1000);
	m = f.create();
	await vi.advanceTimersByTimeAsync(1500);
	await vi.waitFor(() => expect(f.state().pendingChanges).toBe(0));
	expect(f.runner).toHaveBeenCalledTimes(3);
});
it("runs at three hours without another message and counts real updates", async () => {
	vi.useFakeTimers();
	const f = fixture();
	const m = f.create();
	f.change(1);
	await m.runExtraction(f.entry("a"));
	await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000 - 30_000);
	expect(f.runner).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(30_000);
	await vi.waitFor(() => expect(f.state().pendingChanges).toBe(0));
	expect(f.runner).toHaveBeenCalledTimes(2);
	f.change(2);
	await m.runExtraction(f.entry("b"));
	expect(f.state().pendingChanges).toBe(1);
});

it("retains due work after failure and skips consolidation when there are no changes", async () => {
	const f = fixture();
	const m = f.create();
	await m.runConsolidation();
	expect(f.runner).not.toHaveBeenCalled();
	f.change(1);
	await m.runExtraction(f.entry("a"));
	f.fail();
	expect(await m.runConsolidation(true)).toBe(false);
	expect(f.state().pendingChanges).toBe(1);
	// 降噪语义：单次失败静默退避，不亮灯也不丢到期工作；连续 3 轮失败才亮黄灯。
	expect(m.getMaintenanceStatus().phase).not.toBe("warning");
	expect(await m.runConsolidation(true)).toBe(false);
	expect(await m.runConsolidation(true)).toBe(false);
	expect(m.getMaintenanceStatus().phase).toBe("warning");
	expect(f.state().pendingChanges).toBe(1);
});

it("sweeps due work in other workspaces without opening them", async () => {
	const f = fixture();
	const m = f.create();
	const otherDir = join(f.dataRoot, "workspaces", "other", "memory");
	mkdirSync(otherDir, { recursive: true });
	writeFileSync(
		join(otherDir, "other-note.md"),
		"---\nid: workspace/other-note\nname: Other note\ndescription: test\ntype: project\nscope: workspace\nworkspaceId: other\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\nbody-other\n",
	);
	// 先让本工作区落一次账，再手工给另一个工作区记一笔到期的账（5 条马上整）。
	await m.runConsolidation();
	const statePath = join(f.dataRoot, "memory/state.json");
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	state.consolidation.other = {
		sessionIds: [],
		pendingChanges: 5,
		pendingSince: new Date(Date.now() - 1000).toISOString(),
		revision: 0,
	};
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
	await m.runConsolidation();
	const after = JSON.parse(readFileSync(statePath, "utf8"));
	expect(after.consolidation.other.pendingChanges).toBe(0);
	expect(f.runner).toHaveBeenCalled();
});

const profileOperation = (content: string) => ({
	action: "upsert",
	id: MEMORY_PROFILE_ID,
	scope: "global",
	type: "user",
	name: "用户画像",
	description: "常驻用户画像",
	content,
});

function profileFixture(runner: (args: { systemPrompt: string; task: string }) => Promise<string>) {
	const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "profile-"));
	roots.push(root);
	const dataRoot = join(root, "data");
	const options = {
		cwd: root,
		dataRoot,
		agentDir: join(root, "agent"),
		workspaceId: "workspace",
		sessionId: "one",
		persisted: true,
		settingsManager: SettingsManager.inMemory({ autoMemory: { enabled: true, provider: "test", model: "test" } }),
		modelRunner: runner,
	};
	const seedGlobal = (id: string, body: string) => {
		mkdirSync(join(dataRoot, "memory"), { recursive: true });
		writeFileSync(
			join(dataRoot, "memory", `${id.split("/")[1]}.md`),
			`---\nid: ${id}\nname: ${id}\ndescription: ${id} 相关时\ntype: ${id === MEMORY_PROFILE_ID ? "user" : "feedback"}\nscope: global\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n${body}\n`,
		);
	};
	return {
		dataRoot,
		profileFile: join(dataRoot, "memory", "用户画像.md"),
		indexFile: join(dataRoot, "memory", "index.json"),
		seedGlobal,
		create: () => {
			const manager = new AutoMemoryManager(options);
			managers.push(manager);
			return manager;
		},
	};
}

it("creates the first profile version during consolidation when facts are sufficient", async () => {
	const seenTasks: string[] = [];
	const f = profileFixture(async ({ systemPrompt, task }) => {
		if (!systemPrompt.includes("merge duplicates")) return '{"operations":[]}';
		seenTasks.push(task);
		return JSON.stringify({ operations: [profileOperation("初版画像正文：用户说人话，结论先行。")] });
	});
	f.seedGlobal("global/seed-1", "用户要求处理代码任务时先检查真实源码。");
	expect(await f.create().runConsolidation(true)).toBe(true);
	expect(readFileSync(f.profileFile, "utf8")).toContain("初版画像正文");
	// 首批任务在画像不存在时给出明确的首版创建授权。
	expect(seenTasks).toHaveLength(1);
	expect(seenTasks[0]).toContain("it does not exist yet");
	// 文件建立且索引刷新。
	expect(readFileSync(f.indexFile, "utf8")).toContain(MEMORY_PROFILE_ID);
});

it("skips profile creation during consolidation when facts are insufficient", async () => {
	const f = profileFixture(async () => '{"operations":[]}');
	f.seedGlobal("global/seed-1", "今天天气不错。");
	expect(await f.create().runConsolidation(true)).toBe(true);
	expect(existsSync(f.profileFile)).toBe(false);
});

it("rewrites the profile in batch 0 and drops profile operations from later batches", async () => {
	const seenTasks: string[] = [];
	const f = profileFixture(async ({ task }) => {
		seenTasks.push(task);
		return JSON.stringify({
			operations: [
				task.includes("do not create or modify it in this batch")
					? profileOperation("其它批次写入")
					: profileOperation("首批重写"),
			],
		});
	});
	for (let index = 0; index < 21; index++) f.seedGlobal(`global/seed-${index}`, `普通记忆正文 ${index}。`);
	f.seedGlobal(MEMORY_PROFILE_ID, "旧画像");
	expect(await f.create().runConsolidation(true)).toBe(true);
	// 画像固定在 batch 0 重写；其它批次的画像操作被丢弃。
	expect(seenTasks).toHaveLength(2);
	expect(seenTasks[0]).toContain("rewrite the whole entry as usual");
	expect(seenTasks[1]).toContain("do not create or modify it in this batch");
	const rewritten = readFileSync(f.profileFile, "utf8");
	expect(rewritten).toContain("首批重写");
	expect(rewritten).not.toContain("其它批次写入");
});

it("never creates the profile from the sweep path", async () => {
	const f = profileFixture(async () => JSON.stringify({ operations: [profileOperation("清扫创建")] }));
	const otherDir = join(f.dataRoot, "workspaces", "other", "memory");
	mkdirSync(otherDir, { recursive: true });
	writeFileSync(
		join(otherDir, "other-note.md"),
		"---\nid: workspace/other-note\nname: Other note\ndescription: test\ntype: project\nscope: workspace\nworkspaceId: other\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\nbody-other\n",
	);
	await f.create().runConsolidation();
	const statePath = join(f.dataRoot, "memory/state.json");
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	state.consolidation.other = {
		sessionIds: [],
		pendingChanges: 5,
		pendingSince: new Date(Date.now() - 1000).toISOString(),
		revision: 0,
	};
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
	await f.create().runConsolidation();
	const after = JSON.parse(readFileSync(statePath, "utf8"));
	expect(after.consolidation.other.pendingChanges).toBe(0);
	// sweep 的批次过滤丢弃画像创建尝试：全局画像文件不得出现。
	expect(existsSync(f.profileFile)).toBe(false);
});

it("still refuses profile creation on the extraction path", async () => {
	const f = profileFixture(async ({ systemPrompt }) => {
		if (systemPrompt.includes("merge duplicates")) return '{"operations":[]}';
		return JSON.stringify({
			operations: [
				profileOperation("抽取器写入"),
				{
					action: "upsert",
					scope: "global",
					type: "feedback",
					name: "Other",
					description: "其他",
					content: "别的记忆",
				},
			],
		});
	});
	const entries = [
		{ type: "message", id: "user-1", message: { role: "user", content: "记住一些事", timestamp: Date.now() } },
	] as unknown as SessionEntry[];
	expect(await f.create().runExtraction(entries)).toBe(true);
	expect(existsSync(f.profileFile)).toBe(false);
});
