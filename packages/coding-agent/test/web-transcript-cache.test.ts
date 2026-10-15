/**
 * P0-2: transcript projection reuse with exact invalidation (pure) plus an HTTP pass proving the wired
 * host never serves a stale branch and concurrent polls share one result.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@myharness/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/agent/runtime/session-runtime.ts";
import { WebDialogBridge } from "../src/modes/web/dialogs.ts";
import { paginateEntriesToWire, paginateTranscriptItems } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { WebHostHub } from "../src/modes/web/hub.ts";
import { registerCoreRoutes } from "../src/modes/web/routes-core.ts";
import { TranscriptCache } from "../src/modes/web/transcript-cache.ts";
import { entriesToWire } from "../src/modes/web/wire.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import type { SessionEntry } from "../src/session/types.ts";

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2023-07-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1_700_000_000_000 },
	} as SessionEntry;
}

function assistantEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2023-07-01T00:00:01.000Z",
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
			timestamp: 1_700_000_001_000,
		},
	} as SessionEntry;
}

function countingProjector() {
	let calls = 0;
	const project = (branch: readonly SessionEntry[]) => {
		calls += 1;
		return entriesToWire(branch);
	};
	return { project, calls: () => calls };
}

describe("TranscriptCache (pure)", () => {
	it("projects once and reuses the same items while the branch is unchanged", () => {
		const counter = countingProjector();
		const cache = new TranscriptCache(counter.project);
		const branch = [userEntry("e1", null, "q1"), assistantEntry("e2", "e1", "a1")];
		const first = cache.get(branch, "e2");
		const second = cache.get(branch, "e2");
		expect(counter.calls()).toBe(1);
		expect(second).toBe(first); // shared reference: no recomputation
		expect(first.map((item) => item.kind)).toEqual(["user", "assistant"]);
	});

	it("recomputes after an append and serves the new tail", () => {
		const counter = countingProjector();
		const cache = new TranscriptCache(counter.project);
		const before = [userEntry("e1", null, "q1"), assistantEntry("e2", "e1", "a1")];
		cache.get(before, "e2");
		const after = [...before, userEntry("e3", "e2", "q2")];
		const items = cache.get(after, "e3");
		expect(counter.calls()).toBe(2);
		expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "user"]);
		// A repeat poll of the new branch reuses it again.
		expect(cache.get(after, "e3")).toBe(items);
		expect(counter.calls()).toBe(2);
	});

	it("never serves the wrong branch after a switch back and forth", () => {
		const cache = new TranscriptCache();
		const shared = [userEntry("e1", null, "q1")];
		const branchA = [...shared, assistantEntry("e2a", "e1", "answer A")];
		const branchB = [...shared, assistantEntry("e2b", "e1", "answer B")];
		const itemsA = cache.get(branchA, "e2a");
		const itemsB = cache.get(branchB, "e2b");
		expect(itemsB).not.toBe(itemsA);
		expect(JSON.stringify(itemsB)).toContain("answer B");
		// Switching back to A recomputes A's exact projection, not B's leftovers.
		const itemsA2 = cache.get(branchA, "e2a");
		expect(JSON.stringify(itemsA2)).toEqual(JSON.stringify(itemsA));
		expect(JSON.stringify(itemsA2)).toContain("answer A");
	});

	it("rejects replaced content even when entry IDs and leaf are unchanged", () => {
		const cache = new TranscriptCache();
		const first = cache.get([userEntry("e1", null, "old")], "e1");
		const changed = [userEntry("e1", null, "new")];
		expect(cache.peek(changed, "e1")).toBeUndefined();
		const next = cache.get(changed, "e1");
		expect(next).not.toBe(first);
		expect(JSON.stringify(next)).toContain("new");
	});

	it("peek reuses without projecting and misses cleanly on change", () => {
		const counter = countingProjector();
		const cache = new TranscriptCache(counter.project);
		const branch = [userEntry("e1", null, "q1"), assistantEntry("e2", "e1", "a1")];
		expect(cache.peek(branch, "e2")).toBeUndefined(); // nothing cached yet, no projection
		expect(counter.calls()).toBe(0);
		const items = cache.get(branch, "e2");
		expect(cache.peek(branch, "e2")).toBe(items);
		expect(counter.calls()).toBe(1);
		expect(cache.peek([...branch, userEntry("e3", "e2", "q2")], "e3")).toBeUndefined();
		expect(counter.calls()).toBe(1); // peek never projects
	});

	it("invalidate forces the next read to recompute", () => {
		const counter = countingProjector();
		const cache = new TranscriptCache(counter.project);
		const branch = [userEntry("e1", null, "q1")];
		cache.get(branch, "e1");
		cache.invalidate();
		cache.get(branch, "e1");
		expect(counter.calls()).toBe(2);
	});

	it("reuses the normal tail page and invalidates on branch replacement and writes", () => {
		const cache = new TranscriptCache();
		const branch = [userEntry("e1", null, "q1")];
		let calls = 0;
		const project = () => {
			calls++;
			return { items: entriesToWire(branch), hasMore: false, nextCursor: null };
		};
		const first = cache.getPage(branch, "e1", "400", project);
		expect(cache.getPage([...branch], "e1", "400", project)).toBe(first);
		expect(calls).toBe(1);
		expect(cache.getPage([userEntry("e1", null, "changed")], "e1", "400", project)).not.toBe(first);
		expect(calls).toBe(2);
		cache.invalidate();
		cache.getPage(branch, "e1", "400", project);
		expect(calls).toBe(3);
	});

	it("reports its approximate weight for the idle-slot budget", () => {
		const cache = new TranscriptCache();
		expect(cache.approxBytes()).toBe(0);
		cache.get([userEntry("e1", null, "q1"), assistantEntry("e2", "e1", "a1")], "e2");
		expect(cache.approxBytes()).toBeGreaterThan(0);
		cache.invalidate();
		expect(cache.approxBytes()).toBe(0);
	});

	it("same-leaf id reorder is treated as a change, never a hit", () => {
		const cache = new TranscriptCache();
		const branch = [userEntry("e1", null, "q1"), assistantEntry("e2", "e1", "a1")];
		const first = cache.get(branch, "e2");
		// Same leaf and length but a different id order must not reuse the cached branch.
		const reordered = [assistantEntry("e2", null, "a1"), userEntry("e1", "e2", "q1")];
		expect(cache.peek(reordered, "e2")).toBeUndefined();
		expect(cache.get(reordered, "e2")).not.toBe(first);
	});

	it("slicing the cached full projection matches the tail pushdown page", () => {
		const branch: SessionEntry[] = [];
		let parent: string | null = null;
		for (let turn = 0; turn < 4; turn++) {
			const user = userEntry(`u${turn}`, parent, `question ${turn}`);
			branch.push(user);
			parent = user.id;
			const answer = assistantEntry(`a${turn}`, parent, `answer ${turn}`);
			branch.push(answer);
			parent = answer.id;
		}
		const cache = new TranscriptCache();
		const full = cache.get(branch, parent);
		for (const limit of ["1", "2", "3"]) {
			const fromCache = paginateTranscriptItems(full, limit, undefined);
			const pushedDown = paginateEntriesToWire(branch, limit, undefined);
			expect(fromCache).toEqual(pushedDown);
		}
	});
});

// ---- HTTP integration: the wired host reuses polls but never serves a stale branch ----

describe("GET /api/transcript through the cached host (real runtime)", () => {
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

	async function start() {
		const project = tempDir("myharness-tc-project");
		const dataRoot = tempDir("myharness-tc-data");
		const agentDir = tempDir("myharness-tc-agent");
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

		const events: Array<{ event: string; data: any }> = [];
		const sse = request(
			{ host: "127.0.0.1", port: address.port, path: "/api/events", headers: { host: `127.0.0.1:${address.port}` } },
			(res) => {
				res.setEncoding("utf8");
				let buffer = "";
				res.on("data", (chunk) => {
					buffer += chunk;
					let index = buffer.indexOf("\n\n");
					while (index >= 0) {
						const frame = buffer.slice(0, index);
						buffer = buffer.slice(index + 2);
						const event = /^event: (.*)$/m.exec(frame)?.[1];
						const data = /^data: (.*)$/m.exec(frame)?.[1];
						if (event && data) events.push({ event, data: JSON.parse(data) });
						index = buffer.indexOf("\n\n");
					}
				});
			},
		);
		sse.on("error", () => {});
		sse.end();
		cleanups.push(() => {
			sse.destroy();
		});

		const base = `http://127.0.0.1:${address.port}`;
		const get = async (path: string) => {
			const response = await fetch(`${base}${path}`, { headers: { "x-myharness-web": "1" } });
			const json = (await response.json()) as any;
			if (!response.ok) throw new Error(`${response.status}: ${json.error}`);
			return json;
		};
		const post = async (path: string, body: unknown) => {
			const response = await fetch(`${base}${path}`, {
				method: "POST",
				headers: { "x-myharness-web": "1", "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const json = (await response.json()) as any;
			if (!response.ok) throw new Error(`${response.status}: ${json.error}`);
			return json;
		};
		const waitFor = (event: string, timeoutMs = 30_000) =>
			new Promise<any>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
				const poll = () => {
					const hit = events.find((entry) => entry.event === event);
					if (hit) {
						clearTimeout(timer);
						resolve(hit.data);
					} else setTimeout(poll, 25);
				};
				poll();
			});
		return { hub, faux, get, post, waitFor };
	}

	it("shares repeated polls and grows the transcript after a run without going stale", async () => {
		const fx = await start();
		const empty = await fx.get("/api/transcript");
		expect(empty.items).toEqual([]);
		// Concurrent identical polls share one cached projection: all answer identically.
		const polls = await Promise.all(Array.from({ length: 5 }, () => fx.get("/api/transcript")));
		for (const poll of polls) expect(poll).toEqual(empty);

		fx.faux.setResponses([fauxAssistantMessage([fauxText("cached answer")])]);
		await fx.post("/api/prompt", { text: "cache check" });
		await fx.waitFor("run_finished");
		const grown = await fx.get("/api/transcript");
		expect(grown.items.map((item: any) => item.kind)).toEqual(["user", "assistant"]);
		// The paginated tail stitches back to exactly the full body: no stale prefix, no wrong branch.
		const tail = await fx.get("/api/transcript?limit=1");
		expect(tail.hasMore).toBe(true);
		expect(tail.items).toEqual(grown.items.slice(grown.items.length - tail.items.length));
		const head = await fx.get(`/api/transcript?before=${encodeURIComponent(tail.nextCursor)}`);
		expect([...head.items, ...tail.items]).toEqual(grown.items);
		// The snapshot still reports the live outcome, never a cached running state.
		const state = await fx.get("/api/state");
		expect(state.run.state).toBe("idle");
		expect(state.lastRun?.outcome).toBe("completed");
	});
});
