import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionConversationDir, getWorkspaceSessionsDir } from "../../src/config/paths/index.ts";
import { WorkspaceStore } from "../../src/data/workspace-store.ts";
import { paginateSessionSummaries, parseSessionListPagination } from "../../src/modes/web/routes-sessions.ts";
import { SessionManager } from "../../src/session/manager/index.ts";
import {
	appendSessionEntry,
	getSessionScanCacheSizeForTests,
	resetSessionScanCacheForTests,
	resetSessionScanCacheLimitsForTests,
	setSessionScanCacheLimitsForTests,
} from "../../src/session/storage/jsonl/index.ts";
import {
	flushAllWorkspaceIndexes,
	getIndexedSessionMarkers,
	getSessionsIndexPath,
	getSessionsIndexStatsForTests,
	loadWorkspaceIndexSync,
	patchIndexMarker,
	resetSessionsIndexStateForTests,
	resetSessionsIndexStatsForTests,
	unloadWorkspaceIndexForTests,
} from "../../src/session/storage/jsonl/sessions-index.ts";

describe("sessions-index.json persistent session list index", () => {
	let root: string;
	let dataRoot: string;
	let agentDir: string;
	let project: string;
	let workspaceId: string;
	let sessionsDir: string;
	let previousDataRoot: string | undefined;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = join(tmpdir(), `myharness-sessions-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		dataRoot = join(root, "data");
		agentDir = join(root, "agent");
		project = join(root, "project");
		for (const dir of [dataRoot, agentDir, project]) mkdirSync(dir, { recursive: true });
		previousDataRoot = process.env.MYHARNESS_DATA_ROOT;
		previousAgentDir = process.env.MYHARNESS_CODING_AGENT_DIR;
		process.env.MYHARNESS_DATA_ROOT = dataRoot;
		process.env.MYHARNESS_CODING_AGENT_DIR = agentDir;
		workspaceId = WorkspaceStore.create(agentDir, dataRoot).ensureForPath(project).workspaceId;
		sessionsDir = getWorkspaceSessionsDir(dataRoot, workspaceId);
		resetSessionsIndexStateForTests();
		resetSessionsIndexStatsForTests();
		resetSessionScanCacheForTests();
	});

	afterEach(() => {
		flushAllWorkspaceIndexes();
		resetSessionsIndexStateForTests();
		resetSessionsIndexStatsForTests();
		resetSessionScanCacheForTests();
		resetSessionScanCacheLimitsForTests();
		if (previousDataRoot === undefined) delete process.env.MYHARNESS_DATA_ROOT;
		else process.env.MYHARNESS_DATA_ROOT = previousDataRoot;
		if (previousAgentDir === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	function message(role: "user" | "assistant", text: string, id: string, at: number) {
		return JSON.stringify({
			type: "message",
			id,
			parentId: null,
			timestamp: new Date(at).toISOString(),
			message: { role, content: [{ type: "text", text }], timestamp: at },
		});
	}

	function writeSession(sessionId: string, firstText: string, at: number): string {
		const dir = getSessionConversationDir(dataRoot, workspaceId, sessionId);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `${sessionId}.jsonl`);
		const header = JSON.stringify({
			type: "session",
			id: sessionId,
			version: 3,
			timestamp: new Date(at).toISOString(),
			cwd: project,
			mode: "coding",
			workspaceId,
		});
		writeFileSync(file, `${header}\n${message("user", firstText, `${sessionId}-u1`, at + 1000)}\n`);
		return file;
	}

	function rowKey(sessionId: string): string {
		return `${sessionId}/conversation/${sessionId}.jsonl`;
	}

	function readIndexJson(): { version: number; entries: Record<string, unknown> } {
		flushAllWorkspaceIndexes();
		return JSON.parse(readFileSync(getSessionsIndexPath(sessionsDir), "utf8"));
	}

	/** Drop every in-memory cache so the next listing must come from sidecar + disk. */
	function coldStart(): void {
		resetSessionScanCacheForTests();
		unloadWorkspaceIndexForTests(sessionsDir);
		resetSessionsIndexStatsForTests();
	}

	it("builds the sidecar on listing and serves unchanged files with zero parsing", async () => {
		const fileA = writeSession("saaa0001", "alpha question", 1000);
		writeSession("sbbb0002", "beta question", 2000);

		const first = await SessionManager.listAll();
		expect(first).toHaveLength(2);
		const indexJson = readIndexJson();
		expect(indexJson.version).toBe(1);
		expect(Object.keys(indexJson.entries)).toHaveLength(2);
		const row = indexJson.entries[rowKey("saaa0001")];
		expect(row).toMatchObject({ sessionId: "saaa0001", msgCount: 1, preview: "alpha question" });

		coldStart();
		const second = await SessionManager.listAll();
		const stats = getSessionsIndexStatsForTests();
		expect(stats.hits).toBe(2);
		expect(stats.misses).toBe(0);
		const byId = new Map(second.map((info) => [info.id, info]));
		const aFirst = first.find((info) => info.id === "saaa0001")!;
		const aSecond = byId.get("saaa0001")!;
		// Field-for-field alignment with the scanned shape (search text is the preview by design).
		for (const field of [
			"path",
			"id",
			"mode",
			"workspaceId",
			"cwd",
			"firstMessage",
			"messageCount",
			"blank",
		] as const) {
			expect(aSecond[field]).toEqual(aFirst[field]);
		}
		expect(aSecond.created.getTime()).toBe(aFirst.created.getTime());
		expect(aSecond.modified.getTime()).toBe(aFirst.modified.getTime());
		expect(aSecond.allMessagesText).toBe("alpha question");
		expect(existsSync(fileA)).toBe(true);
	});

	it("picks up appended messages incrementally and refreshes the row", async () => {
		const file = writeSession("saaa0001", "alpha question", 1000);
		await SessionManager.listAll();
		appendSessionEntry(file, {
			type: "message",
			id: "m2",
			parentId: null,
			timestamp: new Date(3000).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "beta answer" }], timestamp: 3000 },
		} as never);

		const listed = await SessionManager.listAll();
		expect(listed.find((info) => info.id === "saaa0001")?.messageCount).toBe(2);
		const indexJson = readIndexJson();
		expect(indexJson.entries[rowKey("saaa0001")]).toMatchObject({ msgCount: 2 });
	});

	it("garbage-collects rows for deleted files without touching real files", async () => {
		const fileA = writeSession("saaa0001", "alpha question", 1000);
		writeSession("sbbb0002", "beta question", 2000);
		expect(await SessionManager.listAll()).toHaveLength(2);

		rmSync(join(getSessionConversationDir(dataRoot, workspaceId, "sbbb0002"), "sbbb0002.jsonl"));
		const listed = await SessionManager.listAll();
		expect(listed.map((info) => info.id)).toEqual(["saaa0001"]);
		expect(existsSync(fileA)).toBe(true);
		expect(Object.keys(readIndexJson().entries)).toHaveLength(1);
	});

	it("adds rows for files created without an index row", async () => {
		writeSession("saaa0001", "alpha question", 1000);
		await SessionManager.listAll();
		writeSession("sccc0003", "gamma question", 3000);

		const listed = await SessionManager.listAll();
		expect(listed.map((info) => info.id).sort()).toEqual(["saaa0001", "sccc0003"]);
		expect(Object.keys(readIndexJson().entries)).toHaveLength(2);
	});

	it("does not re-read its own sidecar after writing it, but still sees a change made from outside", async () => {
		writeSession("saaa0001", "alpha question", 1000);
		await SessionManager.listAll();
		// Writing the sidecar renames it into the sessions dir, which moves that dir's mtime.
		flushAllWorkspaceIndexes();
		const entries = loadWorkspaceIndexSync(sessionsDir).entries;
		for (let i = 0; i < 3; i++) {
			getIndexedSessionMarkers(join(getSessionConversationDir(dataRoot, workspaceId, "saaa0001"), "saaa0001.jsonl"));
			expect(loadWorkspaceIndexSync(sessionsDir).entries).toBe(entries);
		}
		// Another process adds a chat folder: the dir changes and the next lookup reads the sidecar again.
		await new Promise((resolve) => setTimeout(resolve, 20));
		mkdirSync(join(sessionsDir, "sexternal"));
		expect(loadWorkspaceIndexSync(sessionsDir).entries).not.toBe(entries);
	});

	it("rebuilds a deleted sidecar from disk", async () => {
		writeSession("saaa0001", "alpha question", 1000);
		await SessionManager.listAll();
		flushAllWorkspaceIndexes();
		rmSync(getSessionsIndexPath(sessionsDir));
		coldStart();

		const listed = await SessionManager.listAll();
		expect(listed.map((info) => info.id)).toEqual(["saaa0001"]);
		expect(Object.keys(readIndexJson().entries)).toHaveLength(1);
	});

	it("rebuilds a corrupt sidecar and keeps a backup", async () => {
		writeSession("saaa0001", "alpha question", 1000);
		await SessionManager.listAll();
		writeFileSync(getSessionsIndexPath(sessionsDir), "not json{{{");
		coldStart();

		const listed = await SessionManager.listAll();
		expect(listed.map((info) => info.id)).toEqual(["saaa0001"]);
		const leftovers = readdirSync(sessionsDir).filter((name) => name.startsWith(".sessions-index.json.corrupt-"));
		expect(leftovers).toHaveLength(1);
		expect(Object.keys(readIndexJson().entries)).toHaveLength(1);
	});

	it("patches markers without touching session data", async () => {
		const file = writeSession("saaa0001", "alpha question", 1000);
		await SessionManager.listAll();

		writeFileSync(`${file}.pinned`, "pinned\n");
		patchIndexMarker(file, "pinned", true);
		expect(getIndexedSessionMarkers(file)).toEqual({ pinned: true, archived: false });

		rmSync(`${file}.pinned`);
		patchIndexMarker(file, "pinned", false);
		expect(getIndexedSessionMarkers(file)).toEqual({ pinned: false, archived: false });
		expect(readFileSync(file, "utf8")).toContain("alpha question");

		// A marker for a file with no row yet is applied when the row is created.
		const fresh = writeSession("sddd0004", "delta question", 4000);
		patchIndexMarker(fresh, "archived", true);
		await SessionManager.listAll();
		expect(getIndexedSessionMarkers(fresh)).toEqual({ pinned: false, archived: true });
	});

	it("detects same-size content swaps via the head hash even when stat matches", async () => {
		const file = writeSession("saaa0001", "alpha question", 1000);
		await SessionManager.listAll();
		flushAllWorkspaceIndexes();

		// Same byte length, same inode: only the head hash can tell the difference.
		const raw = readFileSync(file, "utf8");
		const swapped = raw.replace("alpha question", "ALPHA QUESTION");
		expect(swapped.length).toBe(raw.length);
		writeFileSync(file, swapped);
		const after = statSync(file);
		expect(after.ino).toBeDefined();
		expect(after.size).toBe(raw.length);

		// Force the stat triple to match while keeping the stale head hash: a hit here
		// would serve stale content, so a correct listing proves the hash gate fired.
		const indexPath = getSessionsIndexPath(sessionsDir);
		const persisted = JSON.parse(readFileSync(indexPath, "utf8")) as {
			entries: Record<string, { ino: number; size: number; mtimeMs: number }>;
		};
		persisted.entries[rowKey("saaa0001")] = {
			...persisted.entries[rowKey("saaa0001")]!,
			ino: after.ino,
			size: after.size,
			mtimeMs: after.mtimeMs,
		};
		writeFileSync(indexPath, JSON.stringify(persisted));

		coldStart();
		const listed = await SessionManager.listAll();
		expect(listed.find((info) => info.id === "saaa0001")?.firstMessage).toBe("ALPHA QUESTION");
		expect(getSessionsIndexStatsForTests().misses).toBeGreaterThan(0);
	});

	it("bounds the scan cache and never caches a single over-budget file", async () => {
		setSessionScanCacheLimitsForTests({ maxScans: 5, maxChars: 10_000 });
		for (let i = 0; i < 8; i++) writeSession(`s${String(i).padStart(7, "0")}x`, `question ${i}`, 1000 + i);
		await SessionManager.listAll();
		expect(getSessionScanCacheSizeForTests().scans).toBeLessThanOrEqual(5);

		// One file alone over the budget is not cached at all.
		resetSessionScanCacheForTests();
		setSessionScanCacheLimitsForTests({ maxChars: 10 });
		writeSession("sbigfile0", "this text alone exceeds the tiny test budget", 9000);
		await SessionManager.listAll();
		expect(getSessionScanCacheSizeForTests().scans).toBe(0);
	});

	it("writes the sidecar atomically with no temp leftovers", async () => {
		writeSession("saaa0001", "alpha question", 1000);
		await SessionManager.listAll();
		flushAllWorkspaceIndexes();
		const stray = readdirSync(sessionsDir).filter((name) => name.endsWith(".tmp"));
		expect(stray).toEqual([]);
		expect(JSON.parse(readFileSync(getSessionsIndexPath(sessionsDir), "utf8")).version).toBe(1);
	});

	it("keeps list shape unchanged without pagination and pages with total when asked", () => {
		expect(parseSessionListPagination(new URL("http://x/api/workspaces/sessions"))).toBeUndefined();
		const page = parseSessionListPagination(new URL("http://x/api/workspaces/sessions?limit=10&offset=5"));
		expect(page).toEqual({ limit: 10, offset: 5 });

		expect(() => parseSessionListPagination(new URL("http://x/?limit=0"))).toThrow();
		expect(() => parseSessionListPagination(new URL("http://x/?limit=201"))).toThrow();
		expect(() => parseSessionListPagination(new URL("http://x/?offset=-1"))).toThrow();

		const summaries = [1, 2, 3, 4, 5];
		const plain = paginateSessionSummaries(summaries, undefined);
		expect(plain).toEqual({ sessions: [1, 2, 3, 4, 5] });
		expect("total" in plain).toBe(false);
		expect(paginateSessionSummaries(summaries, { limit: 2, offset: 1 })).toEqual({ sessions: [2, 3], total: 5 });
	});
});
