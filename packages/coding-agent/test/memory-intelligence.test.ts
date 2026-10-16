import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
	AutoMemoryManager,
	estimateMemoryTokens,
	findMemoryContradictions,
	getAutoMemoryPaths,
	isMemoryProfile,
	MEMORY_PROFILE_ID,
	type MemoryEntry,
	readCrossScopeMemoryEntries,
	readMemoryEntries,
	selectMemoriesForQuery,
} from "../src/agent/runtime/auto-memory.ts";
import { restrictToolNamesForRole } from "../src/agent/runtime/role.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { SessionEntry } from "../src/session/manager/index.ts";
import {
	createMemoryClaimToolDefinition,
	createMemoryDeleteToolDefinition,
	createSessionMemoryManageOperations,
} from "../src/tools/memory/manage.ts";
import {
	createMemoryGetToolDefinition,
	createMemorySearchToolDefinition,
	createSessionMemoryOperations,
	type MemoryToolOperations,
} from "../src/tools/memory/search.ts";
import { allToolNames, createAllToolDefinitions, createAllTools } from "../src/tools/registry.ts";

interface MemoryFixture {
	id: string;
	name: string;
	description?: string;
	body: string;
	type?: string;
	importance?: string;
	triggers?: unknown;
	updatedAt?: string;
}

const testRoot = join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-memory-intelligence-tests");
const dataRoot = join(testRoot, "data");
const agentDir = join(testRoot, "agent");
const projectDir = join(testRoot, "project");
const location = { dataRoot, workspaceId: "ws", sessionId: "session-one" };

const enabledSettings = () =>
	SettingsManager.inMemory({
		autoMemory: { enabled: true, provider: "test", model: "memory-model", thinkingLevel: "high" },
	});

function paths() {
	mkdirSync(projectDir, { recursive: true });
	return getAutoMemoryPaths(projectDir, agentDir, location);
}

function directoryFor(scope: "global" | "workspace" | "session"): string {
	const memoryPaths = paths();
	return scope === "global"
		? memoryPaths.globalDir
		: scope === "workspace"
			? memoryPaths.projectDir
			: memoryPaths.sessionDir;
}

/** Write a memory file the way an older or hand-edited file looks: only the fields the fixture names. */
function writeMemory(fixture: MemoryFixture, directory = directoryFor("global")): string {
	const scope = fixture.id.split("/")[0];
	mkdirSync(directory, { recursive: true });
	const file = join(directory, `${fixture.id.slice(scope.length + 1)}.md`);
	const frontmatter = stringifyYaml({
		id: fixture.id,
		name: fixture.name,
		description: fixture.description ?? `${fixture.name} 相关时`,
		type: fixture.type ?? "feedback",
		scope,
		importance: fixture.importance,
		triggers: fixture.triggers,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: fixture.updatedAt ?? "2026-01-01T00:00:00.000Z",
	}).trim();
	writeFileSync(file, `---\n${frontmatter}\n---\n\n${fixture.body}\n`);
	return file;
}

/** 本文件创建的 manager 统一登记，afterEach 统一 dispose：否则残留的后台 timer 会在后续测试里抢本工作区的整理锁。 */
const activeManagers: AutoMemoryManager[] = [];
afterEach(() => {
	for (const instance of activeManagers.splice(0)) instance.dispose();
});

function manager(options: Partial<ConstructorParameters<typeof AutoMemoryManager>[0]> = {}): AutoMemoryManager {
	const instance = new AutoMemoryManager({
		cwd: projectDir,
		sessionId: location.sessionId,
		dataRoot,
		workspaceId: location.workspaceId,
		settingsManager: enabledSettings(),
		persisted: true,
		agentDir,
		...options,
	});
	activeManagers.push(instance);
	return instance;
}

function userEntries(text: string): SessionEntry[] {
	return [
		{
			type: "message",
			id: `user-${text.length}`,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
		},
	] as unknown as SessionEntry[];
}

function entry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "name" | "content">): MemoryEntry {
	return {
		description: `${partial.name} 相关时`,
		type: "feedback",
		scope: "global",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		filePath: `${partial.id}.md`,
		...partial,
	};
}

function snapshotTree(directory: string): string[] {
	const lines: string[] = [];
	const visit = (current: string) => {
		for (const item of readdirSync(current, { withFileTypes: true })) {
			const location = join(current, item.name);
			if (item.isDirectory()) visit(location);
			else lines.push(`${location}|${statSync(location).size}|${statSync(location).mtimeMs}`);
		}
	};
	visit(directory);
	return lines.sort();
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("memory annotations and recall", () => {
	afterEach(() => {
		rmSync(testRoot, { recursive: true, force: true });
	});

	it("still reads and recalls older memories that have no importance or triggers", async () => {
		const file = writeMemory({ id: "global/source-first", name: "Source First", body: "先检查真实源码再下结论。" });
		const entries = readMemoryEntries(paths());
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ id: "global/source-first", importance: undefined, triggers: undefined });
		expect(readFileSync(file, "utf8")).not.toContain("importance");

		const recalled = await manager().recall("请先检查真实源码");
		expect(recalled?.content).toContain("先检查真实源码再下结论");
	});

	it("ignores unusable annotation values instead of rejecting the memory", () => {
		writeMemory({
			id: "global/odd",
			name: "Odd",
			body: "正文",
			importance: "urgent",
			triggers: ["一", "二", "三", "四", "五", "六", "七", "八", "x".repeat(200), "  ", 7],
		});
		writeMemory({ id: "global/single", name: "Single", body: "正文二", triggers: "说人话" });
		const byId = new Map(readMemoryEntries(paths()).map((item) => [item.id, item]));
		expect(byId.get("global/odd")?.importance).toBeUndefined();
		expect(byId.get("global/odd")?.triggers).toHaveLength(6);
		expect(byId.get("global/single")?.triggers).toEqual(["说人话"]);

		writeMemory({ id: "global/long", name: "Long", body: "正文三", triggers: ["x".repeat(200)] });
		const long = readMemoryEntries(paths()).find((item) => item.id === "global/long");
		expect(Buffer.byteLength(long?.triggers?.[0] ?? "", "utf8")).toBeLessThanOrEqual(60);
	});

	it("keeps hand-written importance and triggers when the memory model updates a memory", async () => {
		const file = writeMemory({
			id: "global/plain-talk",
			name: "Plain Talk",
			body: "用户要求说人话。",
			importance: "high",
			triggers: ["别讲术语", "说人话"],
		});
		const extractor = manager({
			modelRunner: async () =>
				'<MEMORY_OPERATIONS>{"operations":[{"action":"upsert","id":"global/plain-talk","scope":"global","type":"feedback","name":"Plain Talk","description":"沟通时相关","content":"用户要求说人话，并且先给结论。"}]}</MEMORY_OPERATIONS>',
		});
		expect(await extractor.runExtraction(userEntries("以后先给结论"))).toBe(true);

		const updated = readFileSync(file, "utf8");
		expect(updated).toContain("先给结论");
		expect(updated).toContain("importance: high");
		expect(updated).toContain("别讲术语");
		expect(updated).toContain("说人话");

		// An empty list from the model does not erase them either, while real new phrases replace them.
		const emptied = manager({
			sessionId: "session-two",
			modelRunner: async () =>
				'<MEMORY_OPERATIONS>{"operations":[{"action":"upsert","id":"global/plain-talk","scope":"global","type":"feedback","name":"Plain Talk","description":"沟通时相关","content":"用户要求说人话，并且先给结论，再讲原因。","triggers":[]}]}</MEMORY_OPERATIONS>',
		});
		await emptied.runExtraction(userEntries("还要讲原因"));
		expect(readFileSync(file, "utf8")).toContain("别讲术语");

		const retagged = manager({
			sessionId: "session-three",
			modelRunner: async () =>
				'<MEMORY_OPERATIONS>{"operations":[{"action":"upsert","id":"global/plain-talk","scope":"global","type":"feedback","name":"Plain Talk","description":"沟通时相关","content":"用户要求说人话，并且先给结论，再讲原因。","importance":"low","triggers":["讲人话"]}]}</MEMORY_OPERATIONS>',
		});
		await retagged.runExtraction(userEntries("调整一下标注"));
		const retaggedText = readFileSync(file, "utf8");
		expect(retaggedText).toContain("importance: low");
		expect(retaggedText).toContain("讲人话");
		expect(retaggedText).not.toContain("别讲术语");
	});

	it("applies annotation-only updates and writes no new fields into untouched older memories", async () => {
		const annotated = writeMemory({ id: "global/habit", name: "Habit", body: "先给方案，用户拍板后再动手。" });
		const untouched = writeMemory({ id: "global/other", name: "Other", body: "完全无关的内容。" });
		const consolidator = manager({
			modelRunner: async () =>
				'<MEMORY_OPERATIONS>{"operations":[{"action":"upsert","id":"global/habit","scope":"global","type":"feedback","name":"Habit","description":"Habit 相关时","content":"先给方案，用户拍板后再动手。","importance":"high","triggers":["先别动手"]}]}</MEMORY_OPERATIONS>',
		});
		expect(await consolidator.runConsolidation(true)).toBe(true);
		const text = readFileSync(annotated, "utf8");
		expect(text).toContain("importance: high");
		expect(text).toContain("先别动手");
		expect(readFileSync(untouched, "utf8")).not.toContain("importance");
		expect(readFileSync(untouched, "utf8")).not.toContain("triggers");
	});

	it("lets triggers bypass the relative-score cut and sends at most three of them", () => {
		const entries = [
			entry({ id: "global/a", name: "Alpha", content: "部署发布流程需要先跑完整测试", description: "部署发布" }),
			...["b", "c", "d", "e"].map((letter, index) =>
				entry({
					id: `global/${letter}`,
					name: `Unrelated ${letter}`,
					content: `完全不同的主题 ${letter}${"x".repeat(index)} 内容`,
					triggers: ["为什么每次都要等我点头"],
					updatedAt: `2026-02-0${index + 1}T00:00:00.000Z`,
				}),
			),
		];
		const results = selectMemoriesForQuery("为什么每次都要等我点头", entries);
		const direct = results.filter((result) => result.via === "trigger");
		expect(direct).toHaveLength(3);
		expect(results.slice(0, 3).every((result) => result.via === "trigger")).toBe(true);
		expect(direct.every((result) => result.triggerHits === 1)).toBe(true);
		// Newest first among equal trigger hits and importance.
		expect(direct.map((result) => result.entry.id)).toEqual(["global/e", "global/d", "global/c"]);

		// Without a trigger the same query, with no shared words, finds nothing.
		const bare = entries.map(({ triggers: _triggers, ...rest }) => rest as MemoryEntry);
		expect(selectMemoriesForQuery("为什么每次都要等我点头", bare)).toEqual([]);
	});

	it("keeps the best match first and guarantees weaker matches instead of cutting them", () => {
		const entries = [
			entry({
				id: "global/strong",
				name: "部署发布",
				content: "部署发布流程需要先跑完整测试再发布",
				description: "部署发布流程",
			}),
			entry({
				id: "global/weak",
				name: "杂项",
				content: `这里提到一次发布${" 其他无关长文本内容".repeat(60)}`,
				description: "杂项备注",
			}),
		];
		// 默认保底 8 条：阈值之外的弱匹配也保留，但最佳匹配仍排第一。
		const ids = selectMemoriesForQuery("部署发布流程怎么走", entries).map((result) => result.entry.id);
		expect(ids).toEqual(["global/strong", "global/weak"]);
		// guaranteed: 0 恢复严格截断行为。
		const strict = selectMemoriesForQuery("部署发布流程怎么走", entries, { guaranteed: 0 }).map(
			(result) => result.entry.id,
		);
		expect(strict).toEqual(["global/strong"]);
	});

	it("keeps every lexical match best-first and guarantees weaker ones up to eight", () => {
		const strong = [0, 1].map((index) =>
			entry({
				id: `global/strong-${index}`,
				name: "部署发布",
				content: `部署发布流程备忘 ${index}`,
				description: "部署发布流程",
			}),
		);
		// 弱匹配只共享一个查询词且正文很长：阈值大概率筛掉它们，保底逻辑把它们捞回来凑满 8 条。
		const weak = Array.from({ length: 8 }, (_, index) =>
			entry({
				id: `global/weak-${String(index).padStart(2, "0")}`,
				name: `杂项 ${index}`,
				content: `这里提到一次发布${" 其他无关长文本内容".repeat(60 + index)}`,
				description: "杂项备注",
			}),
		);
		const results = selectMemoriesForQuery("部署发布流程怎么走", [...strong, ...weak]);
		expect(results).toHaveLength(8);
		expect(results.map((result) => result.entry.id).slice(0, 2)).toEqual(["global/strong-0", "global/strong-1"]);
		const scores = results.map((result) => result.score);
		expect([...scores].sort((a, b) => b - a)).toEqual(scores);
	});

	it("matches trigger phrases by whole phrase, shared two-character groups and whole Latin words", () => {
		const entries = [
			entry({ id: "global/plain", name: "Plain", content: "p", triggers: ["别讲术语"] }),
			entry({ id: "global/rank", name: "Rank", content: "r", triggers: ["上次那个要不要先给排名"] }),
			entry({ id: "global/ci", name: "CI", content: "c", triggers: ["ci"] }),
			entry({ id: "global/two", name: "Two", content: "t", triggers: ["说人话"] }),
		];
		const pick = (query: string) =>
			selectMemoriesForQuery(query, entries)
				.map((result) => result.entry.id)
				.sort();
		expect(pick("你别讲术语了")).toEqual(["global/plain"]);
		expect(pick("你别给我讲术语")).toEqual(["global/plain"]);
		expect(pick("要不要先给排名")).toEqual(["global/rank"]);
		expect(pick("CI 又挂了")).toEqual(["global/ci"]);
		expect(pick("this decision is specific")).toEqual([]);
		expect(pick("讲人话")).toEqual([]); // one shared group is not enough
		expect(pick("请说人话")).toEqual(["global/two"]);
	});

	it("ranks high above normal above low at equal relevance", () => {
		const shared = { name: "Review habit", content: "代码评审时先看测试再看实现", description: "代码评审习惯" };
		const entries = [
			entry({ ...shared, id: "session/low", scope: "session", importance: "low" }),
			entry({ ...shared, id: "workspace/normal", scope: "workspace" }),
			entry({ ...shared, id: "global/high", importance: "high" }),
		];
		const results = selectMemoriesForQuery("代码评审先看什么", entries);
		expect(results.map((result) => result.entry.id)).toEqual(["global/high", "workspace/normal", "session/low"]);
		expect(results[0].score / results[1].score).toBeCloseTo(1.3, 5);
		expect(results[2].score / results[1].score).toBeCloseTo(0.7, 5);
	});

	it("sends the resident profile with every turn exactly once and never ranks it", async () => {
		writeMemory({
			id: MEMORY_PROFILE_ID,
			name: "用户画像",
			type: "user",
			importance: "high",
			triggers: ["说人话", "我是谁"],
			body: "## 沟通与语言偏好\n- 说人话，结论先行。",
		});
		writeMemory({ id: "global/plain-talk", name: "Plain Talk", body: "用户要求说人话。" });

		const entries = readMemoryEntries(paths());
		expect(entries.some(isMemoryProfile)).toBe(true);
		expect(selectMemoriesForQuery("说人话 我是谁", entries).some(({ entry }) => isMemoryProfile(entry))).toBe(false);

		const recalled = await manager().recall("说人话 我是谁");
		const content = String(recalled?.content);
		expect(content.match(/说人话，结论先行/g)).toHaveLength(1);
		expect(content.indexOf("## 用户画像")).toBeLessThan(content.indexOf("## Plain Talk"));
		expect((recalled?.details as { ids: string[] }).ids).toEqual([MEMORY_PROFILE_ID, "global/plain-talk"]);

		// A turn that matches nothing still carries the profile.
		const unrelated = await manager().recall("completely unrelated question about weather");
		expect(String(unrelated?.content)).toContain("说人话，结论先行");
		expect((unrelated?.details as { ids: string[] }).ids).toEqual([MEMORY_PROFILE_ID]);
	});

	it("lets only the consolidator rewrite the profile, and never lets a model retire it", async () => {
		const file = writeMemory({
			id: MEMORY_PROFILE_ID,
			name: "用户画像",
			type: "user",
			importance: "high",
			body: "旧画像",
		});
		const profileOperation = (content: string) =>
			`{"action":"upsert","id":"${MEMORY_PROFILE_ID}","scope":"global","type":"user","name":"用户画像","description":"常驻画像","content":"${content}"}`;

		// Extraction can run a consolidation afterwards with the same runner, so answer each task with its own prompt.
		const extractor = manager({
			modelRunner: async ({ systemPrompt }) =>
				systemPrompt.includes("Memory consolidation task")
					? '<MEMORY_OPERATIONS>{"operations":[]}</MEMORY_OPERATIONS>'
					: `<MEMORY_OPERATIONS>{"operations":[${profileOperation("抽取器写入")},{"action":"upsert","scope":"global","type":"feedback","name":"Other","description":"其他","content":"别的记忆"}]}</MEMORY_OPERATIONS>`,
		});
		await extractor.runExtraction(userEntries("记住一些事"));
		expect(readFileSync(file, "utf8")).toContain("旧画像");
		expect(readFileSync(file, "utf8")).not.toContain("抽取器写入");

		const tasks: string[] = [];
		const consolidator = manager({
			sessionId: "session-two",
			modelRunner: async ({ task }) => {
				tasks.push(task);
				return `<MEMORY_OPERATIONS>{"operations":[${profileOperation("整理器重写")},{"action":"delete","id":"${MEMORY_PROFILE_ID}"}]}</MEMORY_OPERATIONS>`;
			},
		});
		expect(await consolidator.runConsolidation(true)).toBe(true);
		expect(tasks[0]).toContain(`Resident user profile entry ID: ${MEMORY_PROFILE_ID}`);
		expect(tasks[0]).toContain("rewrite the whole entry as usual");
		const rewritten = readFileSync(file, "utf8");
		expect(rewritten).toContain("整理器重写");
		expect(rewritten).toContain("importance: high");
	});

	it("truncates bodies at 10KB on both the read and the write side", async () => {
		const huge = "长".repeat(6000); // 18,000 bytes
		writeMemory({ id: "global/huge", name: "Huge", body: huge });
		const readSide = readMemoryEntries(paths()).find((item) => item.id === "global/huge");
		expect(Buffer.byteLength(readSide?.content ?? "", "utf8")).toBeLessThanOrEqual(10 * 1024);
		expect(Buffer.byteLength(readSide?.content ?? "", "utf8")).toBeGreaterThan(9 * 1024);

		const profileBody = "画".repeat(2600); // 7,800 bytes: a full profile fits whole.
		writeMemory({ id: MEMORY_PROFILE_ID, name: "用户画像", type: "user", body: profileBody });
		const profile = readMemoryEntries(paths()).find(isMemoryProfile);
		expect(profile?.content).toBe(profileBody);

		const written10k = "宽".repeat(6000);
		const writer = manager({
			modelRunner: async ({ systemPrompt }) =>
				systemPrompt.includes("Memory consolidation task")
					? '<MEMORY_OPERATIONS>{"operations":[]}</MEMORY_OPERATIONS>'
					: `<MEMORY_OPERATIONS>{"operations":[{"action":"upsert","scope":"global","type":"feedback","name":"Written","description":"写入侧","content":"${written10k}"}]}</MEMORY_OPERATIONS>`,
		});
		await writer.runExtraction(userEntries("写一条很长的记忆"));
		const written = readMemoryEntries(paths()).find((item) => item.id === "global/written");
		const raw = readFileSync(written?.filePath ?? "", "utf8")
			.split("\n---\n")[1]
			.trim();
		expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(10 * 1024);
		expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(9 * 1024);
	});

	it("degrades silently when memory cannot be read, and writes nothing while recalling", async () => {
		const errors: string[] = [];
		const memoryPaths = paths();
		// The global memory directory is a file: scanning it throws.
		mkdirSync(join(dataRoot), { recursive: true });
		writeFileSync(memoryPaths.globalDir, "not a directory");
		const broken = manager({ onError: (_operation, error) => errors.push(error.message) });
		await expect(broken.recall("任何问题")).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
		rmSync(memoryPaths.globalDir, { force: true });

		// A corrupt file is skipped; the remaining memories still recall, and recall changes nothing on disk.
		writeMemory({ id: "global/good", name: "Good", body: "检查源码是好习惯。" });
		writeFileSync(join(memoryPaths.globalDir, "broken.md"), "---\nid: [unterminated\n---\nbody");
		const before = snapshotTree(dataRoot);
		const recalled = await manager().recall("检查源码");
		expect(String(recalled?.content)).toContain("检查源码是好习惯");
		await manager().recall("再来一次，检查源码");
		expect(snapshotTree(dataRoot)).toEqual(before);
	});

	it("estimates Chinese text at roughly one token per character", () => {
		expect(estimateMemoryTokens("")).toBe(0);
		expect(estimateMemoryTokens("hello")).toBe(2); // 5 ASCII chars pack 4:1
		expect(estimateMemoryTokens("abcdefgh")).toBe(2);
		expect(estimateMemoryTokens("你好")).toBe(2);
		expect(estimateMemoryTokens("一二三四")).toBe(4);
		expect(estimateMemoryTokens("hi你好")).toBe(3); // ceil(2/4) + 2
	});

	it("lists about 120 memories fully in the directory with one-line summaries", async () => {
		for (let index = 0; index < 120; index++) {
			writeMemory({
				id: `global/bulk-${String(index).padStart(3, "0")}`,
				name: `Bulk ${index}`,
				description: `第 ${index} 条批量记忆的摘要说明`,
				body: `批量正文 ${index}：完全不同的主题内容。`,
				updatedAt: `2026-02-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
			});
		}
		writeMemory({
			id: "global/long-desc",
			name: "Long Desc",
			description: "描".repeat(100),
			body: "正文",
			updatedAt: "2026-03-01T00:00:00.000Z",
		});
		const recalled = await manager().recall("彻底无关的火星天气查询");
		const content = String(recalled?.content);
		expect(content).toContain("记忆目录");
		// 121 rows, all listed: no truncation hint.
		for (let index = 0; index < 120; index++) {
			expect(content).toContain(`global/bulk-${String(index).padStart(3, "0")} | global | Bulk ${index} |`);
		}
		expect(content).toContain(`global/long-desc | global | Long Desc | ${"描".repeat(20)}…`);
		expect(content).not.toContain("目录过长");
		expect((recalled?.details as { ids: string[] }).ids).toEqual([]);
		const directoryText = content.slice(content.indexOf("记忆目录"), content.indexOf("</recalled_memory_context>"));
		// 实测：121 行约 3.7k token（新口径），目录预算 4200 覆盖约 130 条。
		expect(estimateMemoryTokens(directoryText)).toBeLessThanOrEqual(4200);
	});

	it("skips an oversized card and still sends a smaller later card", async () => {
		// 240 条填充把目录顶到预算帽，让卡片预算只够小卡片、装不下 10KB 大卡片。
		for (let index = 0; index < 240; index++) {
			writeMemory({
				id: `global/filler-${String(index).padStart(3, "0")}`,
				name: `Filler ${index}`,
				description: `无关填充记忆摘要 ${index}`,
				body: `午餐吃了牛肉面 ${index} 碗，与查询无关。`,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
		}
		writeMemory({
			id: "global/big-card",
			name: "Big Card",
			description: "部署口令相关的大卡片",
			body: `部署口令${"操作步骤说明".repeat(1500)}`,
			triggers: ["部署口令"],
			updatedAt: "2026-03-02T00:00:00.000Z",
		});
		writeMemory({
			id: "global/small-card",
			name: "Small Card",
			description: "部署口令相关的小卡片",
			body: "部署口令的简短说明：先跑测试再发布。",
			updatedAt: "2026-03-01T00:00:00.000Z",
		});
		writeMemory({ id: MEMORY_PROFILE_ID, name: "用户画像", type: "user", body: "画像".repeat(300) });

		const recalled = await manager().recall("部署口令怎么走");
		const ids = (recalled?.details as { ids: string[] }).ids;
		expect(ids).toContain(MEMORY_PROFILE_ID);
		expect(ids).toContain("global/small-card");
		expect(ids).not.toContain("global/big-card");
		expect(String(recalled?.content)).toContain("部署口令的简短说明");
	});

	it("still injects the directory when neither the profile nor any card matches", async () => {
		writeMemory({ id: "global/solo", name: "Solo", description: "午餐记录", body: "午餐吃了牛肉面。" });
		const recalled = await manager().recall("彻底无关的火星天气查询");
		expect(recalled).toBeDefined();
		const content = String(recalled?.content);
		expect(content).toContain("记忆目录");
		expect(content).toContain("global/solo | global | Solo | 午餐记录");
		expect((recalled?.details as { ids: string[] }).ids).toEqual([]);
	});
});

describe("memory_search and memory_get", () => {
	afterEach(() => {
		rmSync(testRoot, { recursive: true, force: true });
	});

	function operations(settings = enabledSettings()): MemoryToolOperations {
		return createSessionMemoryOperations({
			sessionManager: {
				isPersisted: () => true,
				getDataRoot: () => dataRoot,
				getWorkspaceId: () => location.workspaceId,
				getSessionId: () => location.sessionId,
			},
			settingsManager: settings,
		});
	}
	const search = (ops: MemoryToolOperations = operations()) =>
		createMemorySearchToolDefinition(projectDir, { operations: ops });
	const get = (ops: MemoryToolOperations = operations()) =>
		createMemoryGetToolDefinition(projectDir, { operations: ops });
	const run = <T extends { execute: (...args: any[]) => Promise<any> }>(tool: T, input: object) =>
		tool.execute("call", input, undefined, undefined, undefined);

	it("lists the directory without a query, newest first, and says when it truncates", async () => {
		writeMemory({
			id: "global/older",
			name: "Older",
			body: "旧内容",
			updatedAt: "2026-01-01T00:00:00.000Z",
			importance: "low",
		});
		writeMemory({
			id: "global/newer",
			name: "Newer",
			body: "新内容",
			updatedAt: "2026-03-01T00:00:00.000Z",
			importance: "high",
		});
		writeMemory(
			{ id: "workspace/scoped", name: "Scoped", body: "工作区内容", updatedAt: "2026-02-01T00:00:00.000Z" },
			directoryFor("workspace"),
		);

		const listing = await run(search(), {});
		const text = toolText(listing);
		expect(listing.details).toMatchObject({ mode: "directory", total: 3, returned: 3, truncated: false });
		expect(text.indexOf("global/newer")).toBeLessThan(text.indexOf("workspace/scoped"));
		expect(text.indexOf("workspace/scoped")).toBeLessThan(text.indexOf("global/older"));
		expect(text).toContain("id | name | description | importance | type | scope | updatedAt");
		expect(text).toMatch(/global\/newer \| Newer \|.*\| high \| feedback \| global \| 2026-03-01/);
		expect(toolText(await run(search(), { scope: "workspace" }))).not.toContain("global/older");

		for (let index = 0; index < 90; index++) {
			writeMemory({
				id: `global/bulk-${index}`,
				name: `Bulk ${index}`,
				description: "描".repeat(280),
				body: `批量 ${index}`,
			});
		}
		const truncated = await run(search(), {});
		expect(truncated.details).toMatchObject({ mode: "directory", total: 93, truncated: true });
		expect(truncated.details.returned).toBeLessThan(93);
		expect(toolText(truncated)).toContain("已截断");
		expect(Buffer.byteLength(toolText(truncated), "utf8")).toBeLessThan(18 * 1024);
	});

	it("searches with the same ranking as automatic recall and returns summaries, not bodies", async () => {
		writeMemory({
			id: "global/plain-talk",
			name: "Plain Talk",
			body: `用户要求说人话，不要堆术语。${"细节".repeat(200)}`,
			importance: "high",
			triggers: ["别讲术语"],
		});
		writeMemory({ id: "global/release", name: "Release", body: "发布前先跑完整测试。" });
		writeMemory({ id: MEMORY_PROFILE_ID, name: "用户画像", type: "user", body: "画像正文独有标记" });

		const query = "你别讲术语了，发布前要测试吗";
		const entries = readMemoryEntries(paths());
		const expected = selectMemoriesForQuery(query, entries).map(({ entry }) => entry.id);
		expect(expected.length).toBeGreaterThan(0);

		const result = await run(search(), { query, limit: 20 });
		expect(result.details).toMatchObject({ mode: "search", ids: expected });
		const text = toolText(result);
		expect(text).toContain("memory_get");
		expect(text).not.toContain("细节".repeat(100)); // excerpt, not the full body
		expect(text).not.toContain("画像正文独有标记"); // the profile is sent every turn, not searched

		const recalled = await manager().recall(query);
		const recalledIds = (recalled?.details as { ids: string[] }).ids.filter((id) => id !== MEMORY_PROFILE_ID);
		expect(recalledIds).toEqual(expected);

		expect(toolText(await run(search(), { query: "彻底无关的火星天气" }))).toContain("没有匹配的记忆");
	});

	it("gets full text by id, reports unknown or unsafe ids without throwing, and skips archived memories", async () => {
		const body = "第一行\n第二行\n".repeat(300);
		writeMemory({ id: "global/full", name: "Full", body, importance: "high", triggers: ["完整记忆"] });
		writeMemory({ id: "global/second", name: "Second", body: "第二条" });
		// An archived copy with no live memory behind it.
		writeMemory(
			{ id: "global/retired", name: "Retired", body: "已归档的内容" },
			join(directoryFor("global"), "archive"),
		);

		const one = await run(get(), { id: "global/full" });
		const text = toolText(one);
		expect(text).toContain("importance: high");
		expect(text).toContain("完整记忆");
		expect(text.split("第一行").length - 1).toBe(300);
		expect(one.details).toMatchObject({ mode: "get", ids: ["global/full"] });

		const many = toolText(
			await run(get(), { ids: ["global/second", "global/missing", "../etc/passwd", "global/retired"] }),
		);
		expect(many).toContain("第二条");
		expect(many).toContain("未找到记忆：global/missing");
		expect(many).toContain("无效的记忆 id");
		expect(many).toContain("未找到记忆：global/retired");
		expect(many).not.toContain("已归档的内容");

		expect(toolText(await run(get(), {}))).toContain("请提供 id");
		const capped = toolText(
			await run(get(), { ids: ["a", "b", "c", "d", "e", "f"].map((name) => `global/${name}`) }),
		);
		expect(capped).toContain("一次最多读取 5 条");
		expect(toolText(await run(search(), {}))).not.toContain("global/retired");
	});

	it("explains that Auto Memory is off without touching memory storage", async () => {
		writeMemory({ id: "global/secret-note", name: "Secret", body: "不应被读取" });
		const getDataRoot = vi.fn(() => dataRoot);
		const disabled = createSessionMemoryOperations({
			sessionManager: {
				isPersisted: () => true,
				getDataRoot,
				getWorkspaceId: () => location.workspaceId,
				getSessionId: () => location.sessionId,
			},
			settingsManager: SettingsManager.inMemory({ autoMemory: { enabled: false } }),
		});
		for (const result of [
			await run(search(disabled), {}),
			await run(search(disabled), { query: "不应" }),
			await run(get(disabled), { id: "global/secret-note" }),
		]) {
			expect(result.details).toMatchObject({ mode: "disabled" });
			expect(toolText(result)).toContain("Auto Memory 未启用");
			expect(toolText(result)).not.toContain("不应被读取");
		}
		expect(getDataRoot).not.toHaveBeenCalled();

		// The default tool (no wiring) behaves the same way, and a non-persistent session never reads storage.
		expect(toolText(await run(createMemorySearchToolDefinition(projectDir), {}))).toContain("Auto Memory 未启用");
		const ephemeral = createSessionMemoryOperations({
			sessionManager: { isPersisted: () => false, getDataRoot, getWorkspaceId: () => "ws", getSessionId: () => "s" },
			settingsManager: enabledSettings(),
		});
		expect(toolText(await run(get(ephemeral), { id: "global/secret-note" }))).toContain("Auto Memory 未启用");
		expect(getDataRoot).not.toHaveBeenCalled();
	});

	it("hides private keys that a hand-edited memory carries", async () => {
		writeMemory({
			id: "global/key",
			name: "Key",
			body: "-----BEGIN PRIVATE KEY-----\ndummy\n-----END PRIVATE KEY-----",
		});
		writeMemory({ id: "global/token", name: "Token", body: "api_key = sk-live-value" });
		const text = toolText(await run(get(), { ids: ["global/key", "global/token"] }));
		expect(text).not.toContain("dummy");
		expect(text).not.toContain("sk-live-value");
		expect(text).toContain("已隐藏");
	});

	it("is registered as a read-only tool for the main agent but not for delegated sessions", () => {
		expect(allToolNames.has("memory_search")).toBe(true);
		expect(allToolNames.has("memory_get")).toBe(true);
		expect(allToolNames.has("memory_delete")).toBe(true);
		expect(allToolNames.has("memory_claim")).toBe(true);
		const definitions = createAllToolDefinitions(projectDir);
		expect(definitions.memory_search.executionMode).toBe("parallel");
		expect(definitions.memory_get.executionMode).toBe("parallel");
		expect(definitions.memory_delete.executionMode).toBe("sequential");
		expect(definitions.memory_claim.executionMode).toBe("sequential");
		expect(definitions.memory_search.promptSnippet).toContain("long-term memory");
		expect(definitions.memory_get.promptSnippet).toContain("memory_search");
		expect(definitions.memory_delete.promptSnippet).toContain("Permanently delete");
		expect(definitions.memory_claim.promptSnippet).toContain("Claim");
		expect(createAllTools(projectDir).memory_search.name).toBe("memory_search");
		expect(createAllTools(projectDir).memory_delete.name).toBe("memory_delete");
		expect(restrictToolNamesForRole("delegated", ["read", "memory_search", "memory_get"])).toEqual(["read"]);
		expect(restrictToolNamesForRole("delegated", ["read", "memory_delete", "memory_claim"])).toEqual(["read"]);
	});
});

describe("memory v2: resident directory, contradictions, cross-scope access", () => {
	afterEach(() => {
		rmSync(testRoot, { recursive: true, force: true });
	});

	function otherPaths(workspaceId: string, sessionId: string) {
		mkdirSync(projectDir, { recursive: true });
		return getAutoMemoryPaths(projectDir, agentDir, { dataRoot, workspaceId, sessionId });
	}

	function writePending(id: string, name: string, body: string): string {
		const directory = join(dataRoot, "memory", "pending", "legacy-key");
		mkdirSync(directory, { recursive: true });
		const file = join(directory, `${id.slice("pending/".length)}.md`);
		writeFileSync(
			file,
			`---\n${stringifyYaml({ id, name, description: `${name} 相关时`, type: "reference", scope: "pending", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" }).trim()}\n---\n\n${body}\n`,
		);
		return file;
	}

	const manageOps = () =>
		createSessionMemoryManageOperations({
			sessionManager: {
				isPersisted: () => true,
				getDataRoot: () => dataRoot,
				getWorkspaceId: () => location.workspaceId,
				getSessionId: () => location.sessionId,
			},
			settingsManager: enabledSettings(),
		});
	const ops = () =>
		createSessionMemoryOperations({
			sessionManager: {
				isPersisted: () => true,
				getDataRoot: () => dataRoot,
				getWorkspaceId: () => location.workspaceId,
				getSessionId: () => location.sessionId,
			},
			settingsManager: enabledSettings(),
		});
	const search = () => createMemorySearchToolDefinition(projectDir, { operations: ops() });
	const get = () => createMemoryGetToolDefinition(projectDir, { operations: ops() });
	const run = <T extends { execute: (...args: any[]) => Promise<any> }>(tool: T, input: object) =>
		tool.execute("call", input, undefined, undefined, undefined);
	const deleter = () => createMemoryDeleteToolDefinition(projectDir, { operations: manageOps() });
	const claimer = () => createMemoryClaimToolDefinition(projectDir, { operations: manageOps() });

	it("carries a resident directory in every recall while cards stay budgeted", async () => {
		writeMemory({ id: "global/one", name: "One", body: "第一条记忆正文。" });
		writeMemory({ id: "global/two", name: "Two", body: "第二条记忆正文。" });
		writeMemory({
			id: MEMORY_PROFILE_ID,
			name: "用户画像",
			type: "user",
			body: "画像正文独有标记。",
		});

		// Nothing matches: the profile still goes out, and the directory names every own memory.
		const unrelated = await manager().recall("completely unrelated question about weather");
		const unrelatedText = String(unrelated?.content);
		expect(unrelatedText).toContain("画像正文独有标记");
		expect(unrelatedText).toContain("记忆目录");
		expect(unrelatedText).toContain("global/one | global | One");
		expect(unrelatedText).toContain("global/two | global | Two");
		expect(unrelatedText).toContain("memory_get");
		expect((unrelated?.details as { ids: string[] }).ids).toEqual([MEMORY_PROFILE_ID]);

		// A matching turn sends the profile, the directory and the card.
		const matched = await manager().recall("第一条记忆是什么");
		const matchedText = String(matched?.content);
		expect(matchedText).toContain("第一条记忆正文");
		expect(matchedText).toContain("记忆目录");
		expect((matched?.details as { ids: string[] }).ids).toContain("global/one");
	});

	it("nominates same-topic pairs as contradiction candidates and ignores the rest", () => {
		const entries = [
			entry({
				id: "global/deploy-old",
				name: "部署命令",
				content: "生产发布执行 make ship-prod 发布服务",
				description: "部署发布命令",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
			entry({
				id: "global/deploy-new",
				name: "部署命令",
				content: "之前用 make ship-prod，现在改为 make deploy 发布服务",
				description: "部署发布命令",
				updatedAt: "2026-03-01T00:00:00.000Z",
			}),
			entry({
				id: "global/lunch",
				name: "午餐",
				content: "今天中午吃牛肉面",
				description: "午餐记录",
				updatedAt: "2026-03-01T00:00:00.000Z",
			}),
		];
		const pairs = findMemoryContradictions(entries);
		expect(pairs).toHaveLength(1);
		expect(pairs[0].a.id).toBe("global/deploy-old");
		expect(pairs[0].b.id).toBe("global/deploy-new");
		expect(pairs[0].cues).toContain("改为");
		expect(pairs[0].sharedTerms.length).toBeGreaterThanOrEqual(2);
		expect(findMemoryContradictions(entries, 0)).toEqual([]);
		expect(findMemoryContradictions([entries[0]])).toEqual([]);
	});

	it("reads foreign and pending memories without injecting them into recall", async () => {
		writeMemory({
			id: "global/own",
			name: "Own Deploy",
			body: "自己项目的部署流程记忆正文。",
			description: "部署流程",
		});
		const foreign = otherPaths("ws-other", "s-other");
		mkdirSync(foreign.projectDir, { recursive: true });
		writeFileSync(
			join(foreign.projectDir, "deploy.md"),
			`---\n${stringifyYaml({ id: "workspace/deploy", name: "Deploy", description: "别处项目的部署记忆", type: "project", scope: "workspace", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" }).trim()}\n---\n\n别处项目的部署流程记忆。\n`,
		);
		writePending("pending/legacy-note", "Legacy Note", "迁移时没找到主人的记忆。");

		const cross = readCrossScopeMemoryEntries(dataRoot, location);
		const byId = new Map(cross.map((item) => [item.id, item]));
		expect(byId.get("workspace/deploy")?.originLabel).toContain("跨项目");
		expect(byId.get("pending/legacy-note")?.originLabel).toBe("待认领");

		// Automatic recall stays scoped: foreign bodies never become cards.
		const recalled = await manager().recall("部署流程");
		const text = String(recalled?.content);
		expect(text).toContain("自己项目的部署流程记忆正文");
		expect(text).not.toContain("别处项目的部署流程记忆");
		expect(text).not.toContain("workspace/deploy");

		// …but the tools surface them: directory rows, ranked summaries, full text on demand.
		const listing = toolText(await run(search(), {}));
		expect(listing).toContain("workspace/deploy");
		expect(listing).toContain("跨项目");
		expect(listing).toContain("pending/legacy-note");
		expect(listing).toContain("待认领");
		const searched = toolText(await run(search(), { query: "部署流程" }));
		expect(searched).toContain("workspace/deploy");
		const full = toolText(await run(get(), { id: "workspace/deploy" }));
		expect(full).toContain("别处项目的部署流程记忆");
		expect(full).toContain("跨项目");
		const pendingFull = toolText(await run(get(), { id: "pending/legacy-note" }));
		expect(pendingFull).toContain("迁移时没找到主人的记忆");
	});

	it("feeds candidate contradiction pairs to the consolidator task", async () => {
		writeMemory({
			id: "global/deploy-old",
			name: "部署命令",
			body: "生产发布执行 ship 工具发布服务",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		writeMemory({
			id: "global/deploy-new",
			name: "部署命令",
			body: "之前用 ship 工具，现在改为 deploy 工具发布服务",
			updatedAt: "2026-03-01T00:00:00.000Z",
		});
		const tasks: string[] = [];
		const errors: string[] = [];
		const consolidator = manager({
			onError: (_operation, error) => errors.push(error.message),
			modelRunner: async ({ task }) => {
				tasks.push(task);
				return '<MEMORY_OPERATIONS>{"operations":[]}</MEMORY_OPERATIONS>';
			},
		});
		let consolidated = await consolidator.runConsolidation(true);
		// 同文件其他测试留下的后台 timer 可能正在整理本工作区占锁：被跳过时不产生任务，带错或空任务时重试一次。
		if (!consolidated || tasks.length === 0) consolidated = await consolidator.runConsolidation(true);
		consolidator.dispose();
		expect(errors).toEqual([]);
		expect(consolidated).toBe(true);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toContain("Candidate contradiction pairs");
		expect(tasks[0]).toContain("global/deploy-old");
		expect(tasks[0]).toContain("global/deploy-new");
	});

	it("deletes own and pending memories permanently but refuses foreign ones", async () => {
		const active = writeMemory({ id: "global/doomed", name: "Doomed", body: "待删记忆正文。" });
		const { archiveMemoryFile } = await import("../src/session/memory/store.ts");
		await archiveMemoryFile(active, "test");
		const foreign = otherPaths("ws-other", "s-other");
		mkdirSync(foreign.projectDir, { recursive: true });
		writeFileSync(
			join(foreign.projectDir, "keep.md"),
			`---\n${stringifyYaml({ id: "workspace/keep", name: "Keep", description: "别处", type: "project", scope: "workspace", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }).trim()}\n---\n\n别处记忆。\n`,
		);
		writePending("pending/legacy-note", "Legacy Note", "待删的隔离记忆。");

		const refused = toolText(await run(deleter(), { id: "workspace/keep" }));
		expect(refused).toContain("不能删除");
		expect(readFileSync(join(foreign.projectDir, "keep.md"), "utf8")).toContain("别处记忆");

		const pendingDeleted = await run(deleter(), { id: "pending/legacy-note" });
		expect(toolText(pendingDeleted)).toContain("已彻底删除");
		expect(pendingDeleted.details).toMatchObject({ mode: "delete", ids: ["pending/legacy-note"] });

		const ownDeleted = await run(deleter(), { id: "global/doomed" });
		const ownText = toolText(ownDeleted);
		expect(ownText).toContain("已彻底删除");
		expect(ownText).toContain("连带清除 1 个归档版本");
		expect(ownDeleted.details).toMatchObject({ mode: "delete", ids: ["global/doomed"] });
		// 归档与正文都不剩：读目录与 get 都找不到。
		expect(toolText(await run(search(), {}))).not.toContain("global/doomed");
		expect(toolText(await run(get(), { id: "global/doomed" }))).toContain("未找到记忆");

		const invalid = toolText(await run(deleter(), {}));
		expect(invalid).toContain("请提供 id");
	});

	it("claims a pending memory into the current workspace", async () => {
		writePending("pending/legacy-note", "Legacy Note", "认领后属于当前项目。");
		// 认领目标工作区必须已登记：先建 metadata 标记。
		const wsMeta = join(dataRoot, "workspaces", location.workspaceId, "metadata");
		mkdirSync(wsMeta, { recursive: true });
		writeFileSync(join(wsMeta, "workspace.json"), JSON.stringify({ workspace: { rootPath: projectDir } }));

		const notPending = toolText(await run(claimer(), { id: "global/own" }));
		expect(notPending).toContain("只能认领待认领区");

		const claimed = await run(claimer(), { id: "pending/legacy-note" });
		const text = toolText(claimed);
		expect(text).toContain("已认领为当前工作区记忆");
		const newId = (claimed.details as { ids: string[] }).ids[0];
		expect(newId.startsWith("workspace/")).toBe(true);
		// 搬家完成：隔离区清空，工作区可读。
		expect(readCrossScopeMemoryEntries(dataRoot, location).some((item) => item.id === "pending/legacy-note")).toBe(
			false,
		);
		expect(toolText(await run(get(), { id: newId }))).toContain("认领后属于当前项目");
	});
});
