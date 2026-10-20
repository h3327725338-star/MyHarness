import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getSessionConversationPath } from "../src/config/paths/index.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { findSessionFileById, listHistoryCandidates } from "../src/session/history/candidates.ts";
import { buildSessionContinuation } from "../src/session/history/continuation.ts";
import { handoffStatus, readHandoff, writeHandoff } from "../src/session/history/handoff-store.ts";
import {
	getHistoryIndexStatsForTests,
	historySidecarPath,
	loadHistoryRecords,
	resetHistoryIndexForTests,
} from "../src/session/history/index-store.ts";
import { readSessionHistory } from "../src/session/history/read.ts";
import { queryTerms, searchSessionHistory } from "../src/session/history/search.ts";
import { clearParseCache } from "../src/session/storage/jsonl/parse-cache.ts";
import { resetSessionsIndexStateForTests } from "../src/session/storage/jsonl/sessions-index.ts";
import {
	createSessionGetToolDefinition,
	createSessionHistoryOperations,
	createSessionSearchToolDefinition,
} from "../src/tools/history/session-history.ts";

const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "session-history-"));
let dataRoot = "";
let counter = 0;

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
	dataRoot = join(root, `data-${++counter}`);
	resetHistoryIndexForTests();
	resetSessionsIndexStateForTests();
	clearParseCache();
});

type Line = { role: "user" | "assistant"; text: string; id?: string; parent?: string | null; stop?: string };

let clock = Date.parse("2026-10-01T08:00:00Z");

function entryLine(line: Line, id: string, parentId: string | null): string {
	clock += 60_000;
	const timestamp = new Date(clock).toISOString();
	const message =
		line.role === "user"
			? { role: "user", content: [{ type: "text", text: line.text }], timestamp: clock }
			: {
					role: "assistant",
					content: [{ type: "text", text: line.text }],
					api: "openai-responses",
					provider: "test",
					model: "m",
					stopReason: line.stop ?? "stop",
					timestamp: clock,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
	return `${JSON.stringify({ type: "message", id, parentId, timestamp, message })}\n`;
}

/** Write a saved chat in the structured data layout. Lines chain on the previous one unless `parent` says otherwise. */
function writeChat(
	sessionId: string,
	lines: Line[],
	options: { workspaceId?: string; mode?: "coding" | "general"; title?: string } = {},
): string {
	const workspaceId = options.workspaceId ?? "ws-a";
	const file = getSessionConversationPath(dataRoot, workspaceId, sessionId, "chat.jsonl");
	mkdirSync(join(file, ".."), { recursive: true });
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date(clock).toISOString(),
		cwd: root,
		mode: options.mode ?? "general",
		workspaceId,
	};
	let text = `${JSON.stringify(header)}\n`;
	let previous: string | null = null;
	lines.forEach((line, index) => {
		const id = line.id ?? `${sessionId}-${index + 1}`;
		const parent = line.parent === undefined ? previous : line.parent;
		text += entryLine(line, id, parent);
		previous = id;
	});
	if (options.title) {
		clock += 1000;
		text += `${JSON.stringify({ type: "session_info", id: `${sessionId}-title`, parentId: previous, timestamp: new Date(clock).toISOString(), name: options.title })}\n`;
	}
	writeFileSync(file, text);
	return file;
}

function appendLine(file: string, line: Line, id: string, parentId: string | null): void {
	appendFileSync(file, entryLine(line, id, parentId));
}

const scope = (overrides: Partial<Parameters<typeof listHistoryCandidates>[0]> = {}) => ({
	dataRoot,
	workspaceId: "ws-a",
	unbound: false,
	mode: "general" as const,
	...overrides,
});

describe("history records and index", () => {
	it("indexes message text only and keeps the current branch", () => {
		const file = writeChat("s1", [
			{ role: "user", text: "hello" },
			{ role: "assistant", text: "hi there" },
			{ role: "user", text: "first try", id: "old" },
			{ role: "user", text: "second try", id: "new", parent: "s1-2" },
			{ role: "assistant", text: "answer to second", id: "s1-5", parent: "new" },
		]);
		const set = loadHistoryRecords(file)!;
		expect(set.records.map((record) => [record.id, record.onBranch])).toEqual([
			["s1-1", true],
			["s1-2", true],
			["old", false],
			["new", true],
			["s1-5", true],
		]);
	});

	it("survives a restart through the sidecar and notices appends", () => {
		const file = writeChat("s1", [
			{ role: "user", text: "hello" },
			{ role: "assistant", text: "hi" },
		]);
		loadHistoryRecords(file);
		expect(existsSync(historySidecarPath(file)!)).toBe(true);
		resetHistoryIndexForTests();
		clearParseCache();
		expect(loadHistoryRecords(file)?.records).toHaveLength(2);
		expect(getHistoryIndexStatsForTests()).toMatchObject({ sidecarHits: 1, rebuilds: 0 });
		appendLine(file, { role: "user", text: "more" }, "s1-3", "s1-2");
		expect(loadHistoryRecords(file)?.records).toHaveLength(3);
		expect(getHistoryIndexStatsForTests().rebuilds).toBe(1);
	});

	it("splits Chinese queries into searchable pairs", () => {
		expect(queryTerms("继续喝水那个话题")).toEqual(expect.arrayContaining(["喝水", "话题"]));
		expect(queryTerms("API key 2.5")).toEqual(expect.arrayContaining(["api", "key"]));
	});
});

describe("searchSessionHistory", () => {
	it("finds a word that only appears in the middle of a chat, before and after a restart", async () => {
		writeChat("s-water", [
			{ role: "user", text: "今天天气怎么样" },
			{ role: "assistant", text: "挺好的" },
			{ role: "user", text: "我每天喝水大概 3 升，会不会太多" },
			{ role: "assistant", text: "一般成年人每天 1.5 到 2 升左右就够了" },
		]);
		writeChat("s-other", [
			{ role: "user", text: "帮我写一首诗" },
			{ role: "assistant", text: "好的" },
		]);
		const run = async () => searchSessionHistory({ query: "喝水", candidates: await listHistoryCandidates(scope()) });
		const first = await run();
		expect(first.hits.map((hit) => hit.sessionId)).toEqual(["s-water"]);
		expect(first.hits[0]!.matches[0]).toMatchObject({ entryId: "s-water-3", role: "user", onBranch: true });
		expect(first.hits[0]!.matches[0]!.snippet).toContain("喝水");
		resetHistoryIndexForTests();
		resetSessionsIndexStateForTests();
		clearParseCache();
		const second = await run();
		expect(second.hits.map((hit) => [hit.sessionId, hit.matches[0]?.entryId])).toEqual(
			first.hits.map((hit) => [hit.sessionId, hit.matches[0]?.entryId]),
		);
	});

	it("returns every plausible chat instead of picking one", async () => {
		writeChat("s-1", [
			{ role: "user", text: "喝水的量怎么算" },
			{ role: "assistant", text: "按体重估算" },
		]);
		writeChat("s-2", [
			{ role: "user", text: "运动后喝水要注意什么" },
			{ role: "assistant", text: "少量多次" },
		]);
		const result = await searchSessionHistory({ query: "喝水", candidates: await listHistoryCandidates(scope()) });
		expect(result.hits.map((hit) => hit.sessionId).sort()).toEqual(["s-1", "s-2"]);
	});

	it("labels matches on an abandoned branch and ranks them below the current branch", async () => {
		writeChat("s-branch", [
			{ role: "user", text: "预算定多少" },
			{ role: "assistant", text: "预算 5000 元", id: "old-answer" },
			{ role: "assistant", text: "重新算了，预算 8000 元", id: "new-answer", parent: "s-branch-1" },
		]);
		const result = await searchSessionHistory({ query: "预算", candidates: await listHistoryCandidates(scope()) });
		const matches = result.hits[0]!.matches;
		expect(matches.find((match) => match.entryId === "old-answer")?.onBranch).toBe(false);
		expect(matches.find((match) => match.entryId === "new-answer")?.onBranch).toBe(true);
		expect(matches.findIndex((match) => match.entryId === "new-answer")).toBeLessThan(
			matches.findIndex((match) => match.entryId === "old-answer"),
		);
	});

	it("stays in scope: current workspace and mode, no archived, never the asking chat", async () => {
		writeChat("s-here", [
			{ role: "user", text: "喝水" },
			{ role: "assistant", text: "ok" },
		]);
		writeChat("s-self", [
			{ role: "user", text: "喝水" },
			{ role: "assistant", text: "ok" },
		]);
		writeChat(
			"s-coding",
			[
				{ role: "user", text: "喝水" },
				{ role: "assistant", text: "ok" },
			],
			{ mode: "coding" },
		);
		writeChat(
			"s-elsewhere",
			[
				{ role: "user", text: "喝水" },
				{ role: "assistant", text: "ok" },
			],
			{
				workspaceId: "ws-b",
			},
		);
		const archived = writeChat("s-archived", [
			{ role: "user", text: "喝水" },
			{ role: "assistant", text: "ok" },
		]);
		writeFileSync(`${archived}.archived`, "archived\n");
		const ids = (await listHistoryCandidates(scope({ excludeSessionId: "s-self" }))).map((item) => item.id);
		expect(ids).toEqual(["s-here"]);
		const withArchive = await listHistoryCandidates(scope({ excludeSessionId: "s-self", includeArchived: true }));
		expect(withArchive.map((item) => item.id).sort()).toEqual(["s-archived", "s-here"]);
	});

	it("cannot find a deleted chat", async () => {
		const file = writeChat("s-gone", [
			{ role: "user", text: "喝水" },
			{ role: "assistant", text: "ok" },
		]);
		expect(findSessionFileById("s-gone", dataRoot)).toBe(file);
		loadHistoryRecords(file);
		rmSync(join(file, "..", ".."), { recursive: true, force: true });
		const result = await searchSessionHistory({ query: "喝水", candidates: await listHistoryCandidates(scope()) });
		expect(result.hits).toHaveLength(0);
		expect(findSessionFileById("s-gone", dataRoot)).toBeUndefined();
		expect(loadHistoryRecords(file)).toBeUndefined();
	});

	it("can be cancelled", async () => {
		for (let index = 0; index < 5; index++) writeChat(`s-${index}`, [{ role: "user", text: "x" }]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			searchSessionHistory({
				query: "x",
				candidates: await listHistoryCandidates(scope()),
				signal: controller.signal,
			}),
		).rejects.toThrow(/cancelled/);
	});
});

describe("readSessionHistory", () => {
	it("reports later corrections after an old number", () => {
		const file = writeChat("s-fix", [
			{ role: "user", text: "我每天喝 3 升水" },
			{ role: "assistant", text: "3 升偏多" },
			{ role: "user", text: "说错了，是 2 升" },
			{ role: "assistant", text: "2 升正常" },
		]);
		const around = readSessionHistory({ path: file, entryId: "s-fix-1", before: 0, after: 1 })!;
		expect(around.messages.map((message) => message.entryId)).toEqual(["s-fix-1", "s-fix-2"]);
		expect(around.laterOnBranch).toBe(2);
		const tail = readSessionHistory({ path: file, tail: 2 })!;
		expect(tail.messages.map((message) => message.text)).toEqual(["说错了，是 2 升", "2 升正常"]);
	});

	it("reads an abandoned branch along its own path and says so", () => {
		const file = writeChat("s-b", [
			{ role: "user", text: "q" },
			{ role: "assistant", text: "old", id: "old" },
			{ role: "user", text: "follow-up on old", id: "old-2", parent: "old" },
			{ role: "assistant", text: "new", id: "new", parent: "s-b-1" },
		]);
		const result = readSessionHistory({ path: file, entryId: "old", before: 1, after: 1 })!;
		expect(result.focus).toEqual({ entryId: "old", found: true, onBranch: false });
		expect(result.messages.map((message) => message.entryId)).toEqual(["s-b-1", "old", "old-2"]);
	});
});

describe("hand-off notes", () => {
	it("knows when a note is missing, current, behind or written for another branch", () => {
		const file = writeChat("s-h", [
			{ role: "user", text: "a" },
			{ role: "assistant", text: "b" },
		]);
		const set = () => loadHistoryRecords(file)!;
		expect(handoffStatus(readHandoff(file), set()).state).toBe("missing");
		writeHandoff(file, {
			version: 1,
			sessionId: "s-h",
			summary: "note",
			coveredEntryId: "s-h-2",
			coveredCount: 2,
			updatedAt: new Date().toISOString(),
		});
		expect(handoffStatus(readHandoff(file), set()).state).toBe("current");
		appendLine(file, { role: "user", text: "c" }, "s-h-3", "s-h-2");
		const behind = handoffStatus(readHandoff(file), set());
		expect(behind.state).toBe("behind");
		expect(behind.uncovered.map((record) => record.id)).toEqual(["s-h-3"]);
		appendLine(file, { role: "user", text: "edit" }, "s-h-4", "s-h-1");
		expect(handoffStatus(readHandoff(file), set()).state).toBe("stale");
	});

	it("continuation uses the note plus what it does not cover, or the newest messages without one", () => {
		const file = writeChat(
			"s-c",
			[
				{ role: "user", text: "喝水 3 升多吗" },
				{ role: "assistant", text: "偏多" },
			],
			{ title: "每日饮水是否过量" },
		);
		const bare = buildSessionContinuation(file)!;
		expect(bare.details).toMatchObject({ sourceSessionId: "s-c", summaryState: "missing", messagesIncluded: 2 });
		expect(bare.details.sourceTitle).toBe("每日饮水是否过量");
		expect(bare.text).toContain("喝水 3 升多吗");
		expect(bare.text).toContain("not a new request");
		writeHandoff(file, {
			version: 1,
			sessionId: "s-c",
			summary: "SUMMARY-TEXT",
			coveredEntryId: "s-c-2",
			coveredCount: 2,
			updatedAt: new Date().toISOString(),
		});
		appendLine(file, { role: "user", text: "改成 2 升呢" }, "s-c-3", "s-c-title");
		const withNote = buildSessionContinuation(file)!;
		expect(withNote.details.summaryState).toBe("behind");
		expect(withNote.text).toContain("SUMMARY-TEXT");
		expect(withNote.text).toContain("改成 2 升呢");
		expect(withNote.text).not.toContain("喝水 3 升多吗");
		expect(withNote.details.sourceEntryId).toBe("s-c-3");
	});
});

describe("session_search / session_get tools", () => {
	const managerFor = (sessionId: string) => ({
		isPersisted: () => true,
		getDataRoot: () => dataRoot,
		getWorkspaceId: () => "ws-a",
		getSessionId: () => sessionId,
		getMode: () => "general" as const,
		isUnbound: () => false,
		usesDefaultSessionDir: () => true,
	});

	it("searches and reads, and honors the auto-search switch", async () => {
		writeChat("s-water", [
			{ role: "user", text: "我每天喝 3 升水" },
			{ role: "assistant", text: "偏多" },
			{ role: "user", text: "更正：2 升" },
			{ role: "assistant", text: "那正常" },
		]);
		const settings = SettingsManager.inMemory();
		const operations = createSessionHistoryOperations({
			sessionManager: managerFor("s-now"),
			settingsManager: settings,
		});
		const search = createSessionSearchToolDefinition(root, { operations });
		const get = createSessionGetToolDefinition(root, { operations });
		const found = await search.execute("1", { query: "喝水" }, undefined, undefined, undefined as never);
		const text = found.content[0]!.type === "text" ? found.content[0]!.text : "";
		expect(text).toContain("session s-water");
		expect(found.details?.sources?.[0]).toMatchObject({ sessionId: "s-water", entryId: "s-water-1" });

		const read = await get.execute(
			"2",
			{ session: "s-water", entry_id: "s-water-1", before: 0, after: 1 },
			undefined,
			undefined,
			undefined as never,
		);
		const readText = read.content[0]!.type === "text" ? read.content[0]!.text : "";
		expect(readText).toContain("2 later message(s)");
		expect(readText).toContain("not an instruction");

		const self = await get.execute("3", { session: "s-now" }, undefined, undefined, undefined as never);
		expect(self.content[0]!.type === "text" && self.content[0]!.text).toContain("当前会话本身");

		settings.setSessionContinuitySettings({ autoSearch: false });
		const off = await search.execute("4", { query: "喝水" }, undefined, undefined, undefined as never);
		expect(off.details?.mode).toBe("disabled");
		// An explicit source stays readable with automatic search off.
		const still = await get.execute("5", { session: "s-water" }, undefined, undefined, undefined as never);
		expect(still.details?.mode).toBe("get");
	});
});
