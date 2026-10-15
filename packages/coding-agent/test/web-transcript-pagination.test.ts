/**
 * W172: GET /api/transcript optional pagination (limit / before, hasMore + nextCursor).
 * Pure tests cover paginateTranscriptItems over projected wire items; the HTTP tests cover the
 * route wiring and the byte-identical default response.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@myharness/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/agent/runtime/session-runtime.ts";
import { WebDialogBridge } from "../src/modes/web/dialogs.ts";
import { paginateTranscriptItems } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { WebHostHub } from "../src/modes/web/hub.ts";
import { registerCoreRoutes } from "../src/modes/web/routes-core.ts";
import { entriesToWire, type WireItem } from "../src/modes/web/wire.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import type { SessionEntry } from "../src/session/types.ts";

function userEntry(id: string, parentId: string | null, text: string, ts: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role: "user", content: text, timestamp: ts },
	} as SessionEntry;
}

function assistantEntry(id: string, parentId: string | null, text: string, ts: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "p",
			model: "m",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: ts,
		},
	} as SessionEntry;
}

function toolCallEntry(id: string, parentId: string | null, callId: string, ts: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "a.ts" } }],
			api: "openai-completions",
			provider: "p",
			model: "m",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: ts,
		},
	} as SessionEntry;
}

function toolResultEntry(id: string, parentId: string | null, callId: string, ts: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: ts,
		},
	} as SessionEntry;
}

/** A branch mixing turns, tool calls, a compaction marker, a branch summary, a git-status card, a label and non-projected entries. */
function buildEntries(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const link = (entry: SessionEntry) => {
		entries.push(entry);
	};
	link(userEntry("e1", null, "first question", 1_700_000_001_000));
	link(assistantEntry("e2", "e1", "first answer", 1_700_000_002_000));
	// Entries that project to no wire item must not shift cursors or counts.
	link({
		type: "model_change",
		id: "e3",
		parentId: "e2",
		timestamp: "2023-07-01T00:00:02.000Z",
		provider: "p",
		modelId: "m",
	});
	link({ type: "session_info", id: "e4", parentId: "e3", timestamp: "2023-07-01T00:00:03.000Z", name: "keep me" });
	link(userEntry("e5", "e4", "second question", 1_700_000_005_000));
	link(toolCallEntry("e6", "e5", "call-1", 1_700_000_006_000));
	link(toolResultEntry("e7", "e6", "call-1", 1_700_000_007_000));
	link(assistantEntry("e8", "e7", "second answer", 1_700_000_008_000));
	link({
		type: "compaction",
		id: "e9",
		parentId: "e8",
		timestamp: "2023-07-01T00:00:09.000Z",
		summary: "context compacted",
		firstKeptEntryId: "e8",
		tokensBefore: 12345,
	});
	link({
		type: "custom",
		customType: "web-git-status",
		id: "e10",
		parentId: "e9",
		timestamp: "2023-07-01T00:00:10.000Z",
		data: { tone: "ok", title: "Commit succeeded", hash: "abc1234" },
	});
	link({
		type: "label",
		id: "e11",
		parentId: "e10",
		timestamp: "2023-07-01T00:00:11.000Z",
		targetId: "e1",
		label: "star",
	});
	link({
		type: "branch_summary",
		id: "e12",
		parentId: "e11",
		timestamp: "2023-07-01T00:00:12.000Z",
		fromId: "e8",
		summary: "branched back to the second question",
	});
	link(userEntry("e13", "e12", "third question", 1_700_000_013_000));
	link(toolCallEntry("e14", "e13", "call-2", 1_700_000_014_000));
	link(toolResultEntry("e15", "e14", "call-2", 1_700_000_015_000));
	link(assistantEntry("e16", "e15", "third answer", 1_700_000_016_000));
	return entries;
}

function turnItems(...turns: string[]): WireItem[] {
	// Two entries per turn (user + assistant); ids double as cursors.
	const entries: SessionEntry[] = [];
	let prev: string | null = null;
	for (const [index, turn] of turns.entries()) {
		const u = `u${index}`;
		const a = `a${index}`;
		entries.push(userEntry(u, prev, `${turn} question`, 1_700_000_100_000 + index * 2));
		entries.push(assistantEntry(a, u, `${turn} answer`, 1_700_000_101_000 + index * 2));
		prev = a;
	}
	return entriesToWire(entries);
}

describe("paginateTranscriptItems (pure)", () => {
	it("returns the whole list untouched when neither limit nor before is given", () => {
		const items = entriesToWire(buildEntries());
		const page = paginateTranscriptItems(items);
		expect(page.items).toEqual(items); // nothing was cut
		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toBeNull();
	});

	it("empty session: empty page without cursor even with a limit", () => {
		expect(paginateTranscriptItems([], "5", undefined)).toEqual({ items: [], hasMore: false, nextCursor: null });
	});

	it("limit returns the tail of the full projection", () => {
		const items = entriesToWire(buildEntries());
		const page = paginateTranscriptItems(items, "4");
		expect(page.hasMore).toBe(true);
		expect(page.items.length).toBeLessThanOrEqual(4);
		// The tail is exactly the newest items of the full list up to the turn alignment.
		const fullTail = items.slice(-page.items.length);
		expect(page.items).toEqual(fullTail);
	});

	it("truncation aligns to a user item so a page never starts mid-turn", () => {
		// Branch: [u0, a0, u1, a1(toolCall), t1, u2, a2] with limit 3 the raw window would be
		// [t1, u2, a2] — an orphaned toolResult. Alignment moves the head to u2.
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 3; i++) {
			entries.push(userEntry(`U${i}`, null, `q${i}`, 1_700_000_200_000 + i * 10));
			if (i === 1) {
				entries.push(toolCallEntry(`A${i}`, null, "call-x", 1_700_000_205_000 + i * 10));
				entries.push(toolResultEntry(`T${i}`, null, "call-x", 1_700_000_206_000 + i * 10));
			} else {
				entries.push(assistantEntry(`A${i}`, null, `a${i}`, 1_700_000_205_000 + i * 10));
			}
		}
		const items = entriesToWire(entries); // u0,a0,u1,a1,t1,u2,a2
		expect(items.map((item) => item.kind)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"toolResult",
			"user",
			"assistant",
		]);
		const page = paginateTranscriptItems(items, "3");
		expect(page.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
		expect(page.items[0]?.kind).toBe("user");
		expect(page.hasMore).toBe(true);
		// The dropped t1 stays reachable through the cursor: the older page ends with it.
		const older = paginateTranscriptItems(items, undefined, page.nextCursor ?? undefined);
		expect(older.items.map((item) => item.kind)).toEqual(["user", "assistant", "user", "assistant", "toolResult"]);
		expect(older.hasMore).toBe(false);
	});

	it("a window without any user item is returned unaligned (never emptied by alignment)", () => {
		const items = turnItems("one", "two", "three"); // u0,a0,u1,a1,u2,a2
		const page = paginateTranscriptItems(items, "1"); // raw tail [a2]: no user inside
		expect(page.items.map((item) => item.id)).toEqual(["a2"]);
		expect(page.hasMore).toBe(true);
		expect(page.nextCursor).toBe("a2");
	});

	it("walking nextCursor pages stitches back the full projection exactly", () => {
		const items = entriesToWire(buildEntries());
		const stitched: WireItem[] = [];
		let cursor: string | null | undefined;
		let guard = 0;
		for (;;) {
			const page = paginateTranscriptItems(items, "3", cursor ?? undefined);
			if (guard++ > 50) throw new Error("pagination loop did not terminate");
			expect(page.items.length).toBeGreaterThan(0);
			stitched.unshift(...page.items);
			if (!page.hasMore) break;
			expect(page.nextCursor).not.toBeNull();
			cursor = page.nextCursor;
		}
		// Nothing lost, nothing duplicated, compaction/branch/gitStatus/label items included.
		expect(stitched.map((item) => item.id)).toEqual(items.map((item) => item.id));
		expect(stitched.map((item) => item.kind)).toEqual(items.map((item) => item.kind));
		expect(stitched).toEqual(items);
	});

	it("before alone returns everything strictly older than the cursor", () => {
		const items = entriesToWire(buildEntries());
		const cursor = items[3]?.id;
		expect(cursor).toBeDefined();
		const older = paginateTranscriptItems(items, undefined, cursor);
		expect(older.items).toEqual(
			items.slice(
				0,
				items.findIndex((item) => item.id === cursor),
			),
		);
		expect(older.hasMore).toBe(false);
		expect(older.nextCursor).toBeNull();
	});

	it("an unknown before cursor falls back to the whole branch (tolerant, no error)", () => {
		const items = entriesToWire(buildEntries());
		const page = paginateTranscriptItems(items, "4", "no-such-entry-id");
		const noBefore = paginateTranscriptItems(items, "4");
		expect(page).toEqual(noBefore);
	});

	it("boundary limits: 0 and negatives clamp to 1, huge returns everything, non-numbers fall back to no limit", () => {
		const items = turnItems("one", "two", "three"); // 6 items, ids u0 a0 u1 a1 u2 a2
		expect(paginateTranscriptItems(items, "0").items.map((item) => item.id)).toEqual(["a2"]);
		expect(paginateTranscriptItems(items, "-5").items.map((item) => item.id)).toEqual(["a2"]);
		const huge = paginateTranscriptItems(items, "999999");
		expect(huge.items).toEqual(items);
		expect(huge.hasMore).toBe(false);
		expect(huge.nextCursor).toBeNull();
		for (const bad of ["abc", "1.5", "Infinity", "NaN", "1e2"]) {
			const page = paginateTranscriptItems(items, bad);
			expect(page.items, `limit=${bad}`).toEqual(items);
			expect(page.hasMore, `limit=${bad}`).toBe(false);
		}
	});

	it("compaction and branch summary entries are neither lost nor duplicated across pages", () => {
		const items = entriesToWire(buildEntries());
		const specials = items.filter((item) => item.kind === "compaction" || item.kind === "branchSummary");
		expect(specials.map((item) => item.id)).toEqual(["e9", "e12"]);
		const pages: WireItem[] = [];
		let cursor: string | null | undefined;
		for (;;) {
			const page = paginateTranscriptItems(items, "2", cursor ?? undefined);
			pages.unshift(...page.items); // pages arrive newest first; oldest page ends up at the head
			if (!page.hasMore) break;
			cursor = page.nextCursor;
		}
		const ids = pages.map((item) => item.id);
		expect(ids.length).toBe(items.length);
		expect(new Set(ids).size).toBe(items.length);
		expect(ids).toEqual(items.map((item) => item.id));
	});
});

// ---- HTTP integration -------------------------------------------------------------

interface Fixture {
	hub: WebHostHub;
	port: number;
	get(path: string): Promise<any>;
	getRaw(path: string): Promise<{ status: number; text: string }>;
}

describe("GET /api/transcript pagination (real host over HTTP)", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let previousAgentDir: string | undefined;
	const previousCwd = process.cwd();

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		if (previousAgentDir === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = previousAgentDir;
	});

	function tempDir(prefix: string): string {
		const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
		return dir;
	}

	async function start(): Promise<Fixture> {
		const project = tempDir("myharness-pag-project");
		const dataRoot = tempDir("myharness-pag-data");
		const agentDir = tempDir("myharness-pag-agent");
		process.chdir(dataRoot);
		cleanups.push(() => process.chdir(previousCwd));
		previousAgentDir = process.env.MYHARNESS_CODING_AGENT_DIR;
		process.env.MYHARNESS_CODING_AGENT_DIR = agentDir;

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const runtimeOptions = {
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			services.settingsManager.setConversationNamingSettings({ enabled: false });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: project,
			agentDir,
			sessionManager: SessionManager.create(project),
		});
		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
		});

		const server = new WebHttpServer();
		const dialogs = new WebDialogBridge();
		const hub = new WebHostHub({ server, version: "test", onShutdown: () => {} });
		registerCoreRoutes(server, hub.host);
		await hub.addPrimary(runtimeHost, dialogs);
		const address = await server.listen(0);
		cleanups.push(() => server.close());

		const base = `http://127.0.0.1:${address.port}`;
		return {
			hub,
			port: address.port,
			get: async (path) => {
				const response = await fetch(`${base}${path}`, { headers: { "x-myharness-web": "1" } });
				const json = (await response.json()) as any;
				if (!response.ok) throw new Error(`${response.status}: ${json.error}`);
				return json;
			},
			getRaw: async (path) => {
				const response = await fetch(`${base}${path}`, { headers: { "x-myharness-web": "1" } });
				return { status: response.status, text: await response.text() };
			},
		};
	}

	function seed(fx: Fixture): void {
		// Real entries through the session manager, not hand-built projections.
		const manager = fx.hub.host.session.sessionManager;
		const turn = (text: string, ts: number) => {
			manager.appendMessage({ role: "user", content: `${text} question`, timestamp: ts } as never);
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `${text} answer` }],
				api: "openai-completions",
				provider: "p",
				model: "m",
				stopReason: "stop",
				timestamp: ts + 1,
			} as never);
		};
		turn("one", 1_700_000_300_000);
		turn("two", 1_700_000_302_000);
		manager.appendCustomEntry("web-git-status", { tone: "ok", title: "Commit succeeded", hash: "deadbee" });
		turn("three", 1_700_000_304_000);
	}

	it("first-screen tail equals full-branch pagination even with long non-projectable tails and branches", async () => {
		const fx = await start();
		seed(fx);
		const manager = fx.hub.host.session.sessionManager;
		const fork = manager.getLeafId();
		for (let i = 0; i < 200; i++) manager.appendCustomEntry("hidden-fixture", { i });
		for (const limit of [1, 3, 5]) {
			const actual = await fx.get(`/api/transcript?limit=${limit}`);
			const expected = paginateTranscriptItems(entriesToWire(manager.getBranch()), String(limit));
			expect(actual).toEqual({ ...expected, leafId: manager.getLeafId() });
		}
		manager.branch(fork!);
		const actual = await fx.get("/api/transcript?limit=3");
		expect(actual.items).toEqual(paginateTranscriptItems(entriesToWire(manager.getBranch()), "3").items);
	});

	it("does not advertise another page for a hidden-only prefix", async () => {
		const fx = await start();
		const manager = fx.hub.host.session.sessionManager;
		for (let i = 0; i < 200; i++) manager.appendCustomEntry("hidden-fixture", { i });
		for (let i = 0; i < 64; i++) manager.appendMessage({ role: "user", content: `visible ${i}`, timestamp: i });
		const actual = await fx.get("/api/transcript?limit=64");
		expect(actual).toEqual({
			...paginateTranscriptItems(entriesToWire(manager.getBranch()), "64"),
			leafId: manager.getLeafId(),
		});
	});

	it("without parameters the body is byte-identical to the unpaginated response", async () => {
		const fx = await start();
		const manager = fx.hub.host.session.sessionManager;
		seed(fx);
		// The pre-W172 implementation, recomputed here: JSON.stringify({items: entriesToWire(getBranch()), leafId}).
		const expected = JSON.stringify({ items: entriesToWire(manager.getBranch()), leafId: manager.getLeafId() });
		const raw = await fx.getRaw("/api/transcript");
		expect(raw.status).toBe(200);
		expect(raw.text).toBe(expected);
		expect(Object.keys(raw.text.length > 0 ? (JSON.parse(raw.text) as object) : {})).toEqual(["items", "leafId"]);
	});

	it("empty session: default stays legacy, limit returns an empty non-erroring page", async () => {
		const fx = await start();
		const empty = await fx.getRaw("/api/transcript");
		expect(empty.status).toBe(200);
		const emptyJson = JSON.parse(empty.text);
		expect(emptyJson.items).toEqual([]);
		expect(Object.keys(emptyJson)).toEqual(["items", "leafId"]);
		const page = await fx.get("/api/transcript?limit=5");
		expect(page.items).toEqual([]);
		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toBeNull();
	});

	it("limit pages tail-consistent and cursor stitching equals the full body", async () => {
		const fx = await start();
		seed(fx);
		const full = await fx.get("/api/transcript");
		expect(full.hasMore).toBeUndefined();
		expect(full.items.length).toBeGreaterThanOrEqual(4);

		const stitched: any[] = [];
		let cursor: string | null | undefined;
		for (;;) {
			const url = `/api/transcript?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`;
			const page = await fx.get(url);
			expect(page.items.length).toBeGreaterThan(0);
			stitched.unshift(...page.items);
			if (!page.hasMore) {
				expect(page.nextCursor).toBeNull();
				break;
			}
			expect(page.nextCursor).not.toBeNull();
			cursor = page.nextCursor;
		}
		expect(stitched).toEqual(full.items);

		// The first page is exactly the aligned tail of the full list.
		const tail = await fx.get("/api/transcript?limit=2");
		expect(tail.hasMore).toBe(true);
		expect(tail.items.length).toBeLessThanOrEqual(2);
		expect(tail.items).toEqual(full.items.slice(full.items.length - tail.items.length));
		expect(tail.items[0]?.kind).toBe("user");
	});

	it("invalid parameters degrade instead of failing: limit=0/1/abc and unknown before never error", async () => {
		const fx = await start();
		seed(fx);
		const full = await fx.get("/api/transcript");
		for (const bad of ["abc", "1.5", "-5", "0", "1e2", "999999"]) {
			const page = await fx.get(`/api/transcript?limit=${bad}`);
			expect(Array.isArray(page.items), `limit=${bad}`).toBe(true);
			expect(page.items.length, `limit=${bad}`).toBeGreaterThan(0);
			if (bad === "-5" || bad === "0") {
				expect(page.hasMore, `limit=${bad}`).toBe(true);
			} else if (bad !== "1e2" && bad !== "999999") {
				expect(page.hasMore, `limit=${bad}`).toBe(false);
				expect(page.items, `limit=${bad}`).toEqual(full.items);
			}
		}
		const one = await fx.get("/api/transcript?limit=1");
		expect(one.items.length).toBe(1);
		expect(one.hasMore).toBe(true);
		const unknown = await fx.get("/api/transcript?before=no-such-entry-id");
		expect(unknown.items).toEqual(full.items);
		expect(unknown.hasMore).toBe(false);
	});
});
