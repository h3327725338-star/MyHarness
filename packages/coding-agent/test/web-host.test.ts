import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@myharness/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/agent/runtime/session-runtime.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import { WebDialogBridge } from "../src/modes/web/dialogs.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { WebHostHub } from "../src/modes/web/hub.ts";
import { registerCoreRoutes } from "../src/modes/web/routes-core.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";
import { registerGitRoutes } from "../src/modes/web/routes-git.ts";
import { registerProviderRoutes } from "../src/modes/web/routes-providers.ts";
import { registerSessionRoutes } from "../src/modes/web/routes-sessions.ts";
import { registerSettingsRoutes } from "../src/modes/web/routes-settings.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { showPopupNotification } from "../src/utils/popup-notification.ts";

// A task that ends may show the system popup (see WebHost.announceTaskEnd); the tests only record that it would.
vi.mock("../src/utils/popup-notification.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/popup-notification.ts")>();
	return { ...actual, showPopupNotification: vi.fn(() => true) };
});

const showPopupMock = vi.mocked(showPopupNotification);

interface Fixture {
	hub: WebHostHub;
	port: number;
	project: string;
	events: Array<{ event: string; data: any }>;
	get(path: string, slot?: string): Promise<any>;
	post(path: string, body?: unknown, slot?: string): Promise<any>;
	waitFor(event: string, predicate?: (data: any) => boolean, timeoutMs?: number): Promise<any>;
	faux: ReturnType<typeof registerFauxProvider>;
}

describe("Web host (real runtime with a faux provider)", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let previousAgentDir: string | undefined;
	const previousCwd = process.cwd();

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		if (previousAgentDir === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = previousAgentDir;
		showPopupMock.mockClear();
	});

	function tempDir(prefix: string): string {
		const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
		return dir;
	}

	it("reports real completion phases, restores snapshots, and clears failures", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const owner = fx.hub.get(initial.slot)!;
		const internals = owner as any;
		internals.lastAgentEnd = { succeeded: true, messages: [] };
		const extraction = vi.spyOn(owner.session, "scheduleAutoMemoryMaintenance");
		owner.session.settingsManager.setAutoMemorySettings({ enabled: false });
		internals.startCompletion();
		await owner.waitForCompletion();
		expect(extraction).not.toHaveBeenCalled();
		expect(internals.completionStatus).toBeUndefined();
		await fx.waitFor("completion", (d) => d.active === false);
		expect(fx.events.filter((event) => event.event === "completion").map((event) => event.data.phase)).not.toContain(
			"memory",
		);

		owner.session.settingsManager.setAutoMemorySettings({ enabled: true });
		extraction.mockResolvedValue(undefined);
		internals.startCompletion();
		await owner.waitForCompletion();
		expect(extraction).toHaveBeenCalledOnce();
		expect(fx.events.filter((event) => event.event === "completion").map((event) => event.data.phase)).not.toContain(
			"memory",
		);
		expect((await fx.get("/api/state")).flags.completionStatus).toBeNull();

		extraction.mockRejectedValueOnce(new Error("extraction unavailable"));
		internals.startCompletion();
		await owner.waitForCompletion();
		expect(owner.completionActive).toBe(false);
		expect((await fx.get("/api/state")).flags.completionStatus).toBeNull();
		await fx.waitFor("notice", (d) => d.message.includes("extraction unavailable"));
	});

	it("finishes the chat while background memory is still waiting for its model", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const owner = fx.hub.get(initial.slot)!;
		owner.session.settingsManager.setAutoMemorySettings({ enabled: true, provider: "test", model: "memory" });
		owner.session.sessionManager.appendMessage({
			role: "user",
			content: "Remember the confirmed project convention",
			timestamp: Date.now(),
		});
		const memory = (owner.session as any)._autoMemory;
		let release!: () => void;
		vi.spyOn(memory, "runExtraction").mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					release = () => resolve(false);
				}),
		);
		try {
			(owner as any).lastAgentEnd = { succeeded: true, messages: [] };
			(owner as any).startCompletion();
			await owner.waitForCompletion();
			await fx.waitFor("memory_status", (d) => d.phase === "processing");
			const snapshot = await fx.get("/api/state");
			expect(snapshot.memoryMaintenance.phase).toBe("processing");
			expect(snapshot.flags.completion).toBe(false);
			expect(owner.session.isIdle).toBe(true);
		} finally {
			release?.();
		}
	});

	it("keeps only current-turn recalled memory in model context without rewriting history", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const session = fx.hub.get(initial.slot)!.session;
		const old = {
			role: "custom" as const,
			customType: "auto-memory-recall",
			content: "old memory",
			display: false,
			timestamp: Date.now(),
		};
		const current = { ...old, content: "current memory" };
		const history = [old, { role: "user" as const, content: "new question", timestamp: Date.now() }, current];
		const context = await session.agent.transformContext!(history, new AbortController().signal);
		expect(context).not.toContain(old);
		expect(context).toContainEqual(current);
		expect(history).toHaveLength(3);
	});

	it("publishes usage in the same batch as text before provider usage arrives", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const owner = fx.hub.get(initial.slot)!;
		const message = fauxAssistantMessage(fauxText("Streaming output without reported usage"));
		message.usage.output = 0;
		const internals = owner as any;
		internals.onSessionEvent({ type: "message_start", message });
		internals.onSessionEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", delta: "Streaming output without reported usage" },
		});
		internals.flushAssistant();
		expect(owner.usage().stats.tokens.output).toBeGreaterThan(0);
		expect(owner.usage().stats.usageEstimated).toBe(true);
		message.usage.output = 17;
		expect(owner.usage().stats.tokens.output).toBe(17);
		expect(owner.usage().stats.usageEstimated).toBe(false);
	});

	it("keeps an in-flight Commit slot and restores its progress snapshot", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const owner = fx.hub.get(initial.slot)!;
		owner.broadcast("git_task", {
			active: true,
			kind: "commit",
			phase: "committing",
			activity: "Committing",
			startedAt: Date.now(),
		});
		const next = await fx.post("/api/sessions/new", {}, initial.slot);
		expect(next.slot).not.toBe(initial.slot);
		expect((await fx.get("/api/slots")).slots.find((slot: any) => slot.slot === initial.slot)).toMatchObject({
			hasContent: true,
			active: true,
		});
		expect((await fx.get("/api/state", initial.slot)).gitTask).toMatchObject({ kind: "commit", phase: "committing" });
		owner.broadcast("git_task", { active: false });
		expect(owner.hasOperationContent).toBe(true);
	});

	it("protects a touched draft from empty-chat reuse", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		await fx.post("/api/sessions/touched", {}, initial.slot);
		const next = await fx.post("/api/sessions/new", {}, initial.slot);
		expect(next.slot).not.toBe(initial.slot);
		expect((await fx.get("/api/slots")).slots.find((slot: any) => slot.slot === initial.slot).hasContent).toBe(true);
	});

	it("archives a deferred draft without inventing messages and restores it from disk", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const path = initial.session.file;
		await fx.post("/api/sessions/touched", {}, initial.slot);
		const next = await fx.post("/api/sessions/new", {}, initial.slot);
		expect(existsSync(path)).toBe(false);
		await fx.post("/api/sessions/archive", { path }, next.slot);
		expect(existsSync(path)).toBe(true);
		expect((await fx.get("/api/sessions/archived")).sessions.map((info: any) => info.path)).toContain(path);
		expect((await fx.get("/api/state", initial.slot)).session.file).toBe(path);
		expect(SessionManager.open(path).buildSessionContext().messages).toHaveLength(0);
		await fx.hub.closeSlot(fx.hub.get(initial.slot)!);
		await fx.post("/api/sessions/archive", { path, archived: false }, next.slot);
		const reopened = await fx.post("/api/sessions/open", { path }, next.slot);
		expect((await fx.get("/api/state", reopened.slot)).session.file).toBe(path);
	});

	it.each([false, true])("deletes deferred drafts with deleteArtifacts=%s", async (deleteArtifacts) => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const path = initial.session.file;
		await fx.post("/api/sessions/touched", {}, initial.slot);
		const uploads = join(dirname(path), "uploads");
		mkdirSync(uploads, { recursive: true });
		writeFileSync(join(uploads, "draft.txt"), "attachment");
		const report = join(dirname(dirname(path)), "artifacts", "reports", "report.txt");
		mkdirSync(dirname(report), { recursive: true });
		writeFileSync(report, "keep unless explicitly deleted");
		const next = await fx.post("/api/sessions/new", {}, initial.slot);
		expect(existsSync(path)).toBe(false);
		await fx.post("/api/sessions/delete", { path, deleteArtifacts }, next.slot);
		expect(fx.hub.slotsShowing(path)).toHaveLength(0);
		expect(existsSync(uploads)).toBe(false);
		expect(existsSync(report)).toBe(!deleteArtifacts);
		expect(existsSync(dirname(dirname(path)))).toBe(!deleteArtifacts);
		expect((await fx.get("/api/state", next.slot)).slot).toBe(next.slot);
	});

	it("replaces the requesting slot when deleting its deferred current draft", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		await fx.post("/api/sessions/touched", {}, initial.slot);
		await fx.post("/api/sessions/new", {}, initial.slot);
		await fx.post("/api/sessions/delete", { path: initial.session.file }, initial.slot);
		const after = await fx.get("/api/state", initial.slot);
		expect(after.slot).toBe(initial.slot);
		expect(after.session.file).not.toBe(initial.session.file);
		expect(fx.hub.slotsShowing(initial.session.file)).toHaveLength(0);
	});

	it("refuses busy deferred drafts and arbitrary unknown paths", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const owner = fx.hub.get(initial.slot)!;
		owner.broadcast("git_task", { active: true, kind: "commit", phase: "committing", startedAt: Date.now() });
		try {
			await expect(fx.post("/api/sessions/archive", { path: initial.session.file })).rejects.toThrow("409:");
			await expect(fx.post("/api/sessions/delete", { path: initial.session.file })).rejects.toThrow("409:");
			expect(existsSync(initial.session.file)).toBe(false);
		} finally {
			owner.broadcast("git_task", { active: false });
		}
		const unknown = join(fx.project, "unknown.jsonl");
		await expect(fx.post("/api/sessions/archive", { path: unknown })).rejects.toThrow("404: Unknown session");
		await expect(fx.post("/api/sessions/delete", { path: unknown })).rejects.toThrow("404: Unknown session");
		expect(existsSync(`${unknown}.archived`)).toBe(false);
	});

	it("persists a new chat containing only a Commit card and does not reuse it as empty", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const record = { tone: "ok", title: "Commit succeeded", hash: "abc1234", detail: "Saved" };
		await fx.post("/api/git/record", record);
		expect(existsSync(initial.session.file)).toBe(true);
		const saved = SessionManager.open(initial.session.file);
		expect(saved.getEntries().some((entry) => entry.type === "custom" && entry.customType === "web-git-status")).toBe(
			true,
		);
		expect(saved.buildSessionContext().messages).toHaveLength(0);
		const next = await fx.post("/api/sessions/new", {});
		expect(next.created).toBe(true);
		const slots = await fx.waitFor("slots", (data) =>
			data.slots.some((slot: any) => slot.sessionFile === initial.session.file && slot.hasContent),
		);
		expect(slots.slots.some((slot: any) => slot.sessionFile === initial.session.file && slot.hasContent)).toBe(true);
	});

	async function start(): Promise<Fixture> {
		const project = tempDir("myharness-web-project");
		const dataRoot = tempDir("myharness-web-data");
		const agentDir = tempDir("myharness-web-agent");
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
		const host = hub.host;
		registerCoreRoutes(server, host);
		registerSessionRoutes(server, host, hub);
		registerFileRoutes(server, host);
		registerGitRoutes(server, host);
		registerSettingsRoutes(server, host);
		// An undecided thinking-effort test is tried again; the tests do not wait between the attempts.
		registerProviderRoutes(server, host, hub, { probeRetryDelaysMs: [0, 0, 0] });
		await hub.addPrimary(runtimeHost, dialogs);
		const address = await server.listen(0);
		cleanups.push(() => server.close());

		const events: Array<{ event: string; data: any }> = [];
		const listeners: Array<() => void> = [];
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
						for (const listener of listeners) listener();
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

		const call = async (method: string, path: string, body?: unknown, slot?: string) => {
			const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
				method,
				headers: {
					"x-myharness-web": "1",
					"content-type": "application/json",
					...(slot ? { "x-myharness-slot": slot } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const json = (await response.json()) as any;
			if (!response.ok) throw new Error(`${response.status}: ${json.error}`);
			return json;
		};
		return {
			hub,
			port: address.port,
			project,
			events,
			faux,
			get: (path, slot) => call("GET", path, undefined, slot),
			post: (path, body, slot) => call("POST", path, body ?? {}, slot),
			waitFor: (event, predicate = () => true, timeoutMs = 15_000) =>
				new Promise((resolve, reject) => {
					const find = () => events.find((entry) => entry.event === event && predicate(entry.data));
					const found = find();
					if (found) return resolve(found.data);
					const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
					const listener = () => {
						const hit = find();
						if (hit) {
							clearTimeout(timer);
							resolve(hit.data);
						}
					};
					listeners.push(listener);
				}),
		};
	}

	it("compares code intelligence selection with the live runtime instead of treating a saved setting as active", async () => {
		const fx = await start();
		const before = await fx.get("/api/code-intelligence/modules");
		expect(before.restartRequired).toBe(false);
		const selected = !before.runtime.semanticEnabled;
		await fx.post("/api/settings", { id: "codeIntelligence.enabled", value: selected });
		const pending = await fx.get("/api/code-intelligence/modules");
		expect(pending.configuredMode).toBe(selected ? "semantic" : "lightweight");
		expect(pending.activeMode).toBe(before.activeMode);
		expect(pending.restartRequired).toBe(true);
		await fx.post("/api/settings", { id: "codeIntelligence.enabled", value: before.runtime.semanticEnabled });
		expect((await fx.get("/api/code-intelligence/modules")).restartRequired).toBe(false);
	});

	it("archives and restores a saved chat, then physically deletes it and resets the active view", async () => {
		const fx = await start();
		fx.faux.setResponses([fauxAssistantMessage([fauxText("saved answer")])]);
		await fx.post("/api/prompt", { text: "saved chat" });
		await fx.waitFor("run_finished");
		const before = await fx.get("/api/state");
		const path = before.session.file;
		expect(existsSync(path)).toBe(true);
		await fx.post("/api/sessions/archive", { path });
		expect(existsSync(path)).toBe(true);
		// Archiving only moves the chat in the sidebar: the chat on screen is not replaced.
		expect((await fx.get("/api/state")).session.file).toBe(path);
		expect((await fx.get("/api/sessions/archived")).sessions.map((info: any) => info.path)).toContain(path);
		expect(
			(await fx.get(`/api/workspaces/sessions?path=${encodeURIComponent(fx.project)}`)).sessions.map(
				(info: any) => info.path,
			),
		).not.toContain(path);
		await fx.post("/api/sessions/archive", { path, archived: false });
		expect(existsSync(`${path}.archived`)).toBe(false);
		await fx.post("/api/sessions/open", { path });
		await fx.post("/api/sessions/delete", { path });
		expect(existsSync(path)).toBe(false);
		expect((await fx.get("/api/state")).session.file).not.toBe(path);
		expect(
			(await fx.get(`/api/workspaces/sessions?path=${encodeURIComponent(fx.project)}`)).sessions.map(
				(info: any) => info.path,
			),
		).not.toContain(path);
	});

	it("gives the Agent a conversation artifact path and indexes tool-created output", async () => {
		const fx = await start();
		const owner = fx.hub.get((await fx.get("/api/state")).slot)!;
		const path = join(dirname(dirname(owner.session.sessionFile!)), "artifacts", "tests", "verification.txt");
		fx.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path, content: "verification result" })]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await fx.post("/api/prompt", { text: "write temporary verification output" });
		await fx.waitFor("run_finished");
		expect(owner.session.agent.state.systemPrompt).toContain("<session_artifacts>");
		expect(owner.session.agent.state.systemPrompt).toContain(dirname(dirname(path)));
		expect(readFileSync(path, "utf8")).toBe("verification result");
		expect((await fx.get("/api/artifacts?scope=session")).entries[0].name).toBe("tests/verification.txt");
	});

	it("lists conversation artifacts globally and keeps them after default chat deletion", async () => {
		const fx = await start();
		fx.faux.setResponses([fauxAssistantMessage([fauxText("saved answer")])]);
		await fx.post("/api/prompt", { text: "artifact chat" });
		await fx.waitFor("run_finished");
		const file = (await fx.get("/api/state")).session.file;
		const artifact = join(dirname(dirname(file)), "artifacts", "reports", "report.md");
		writeFileSync(artifact, "kept report");
		expect((await fx.get("/api/artifacts?scope=session")).entries).toHaveLength(1);
		await fx.post("/api/sessions/delete", { path: file });
		const entries = (await fx.get("/api/artifacts?scope=global")).entries;
		const kept = entries.find((entry: any) => entry.path.endsWith("/reports/report.md"));
		expect(kept).toBeDefined();
		expect(kept.conversationDeleted).toBe(true);
		expect(existsSync(artifact)).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	it("pins a chat with a marker, reports its last activity and drops the marker with the chat", async () => {
		const fx = await start();
		const initial = await fx.get("/api/state");
		const slotOf = async () => (await fx.get("/api/slots")).slots.find((s: any) => s.slot === initial.slot);
		expect((await slotOf()).lastActivityAt).toBeNull();
		fx.faux.setResponses([fauxAssistantMessage([fauxText("pinned answer")])]);
		const before = Date.now();
		await fx.post("/api/prompt", { text: "pin me" });
		await fx.waitFor("run_finished");
		expect((await slotOf()).lastActivityAt).toBeGreaterThanOrEqual(before);
		const path = (await fx.get("/api/state")).session.file;
		const listed = async () =>
			(await fx.get(`/api/workspaces/sessions?path=${encodeURIComponent(fx.project)}`)).sessions.find(
				(info: any) => info.path === path,
			);
		expect((await listed()).pinned).toBe(false);
		await fx.post("/api/sessions/pin", { path });
		expect(existsSync(`${path}.pinned`)).toBe(true);
		expect((await listed()).pinned).toBe(true);
		await fx.post("/api/sessions/pin", { path, pinned: false });
		expect((await listed()).pinned).toBe(false);
		await fx.post("/api/sessions/pin", { path });
		await fx.post("/api/sessions/delete", { path });
		expect(existsSync(`${path}.pinned`)).toBe(false);
	});

	it("renames a workspace alias through the API and broadcasts the change without moving its folder", async () => {
		const fx = await start();
		const snapshot = await fx.get("/api/state");
		const workspace = snapshot.workspace;
		expect(workspace).toBeTruthy();
		await fx.post("/api/workspaces/rename", { id: workspace.id, name: "Friendly alias" });
		const renamed = (await fx.get("/api/state")).workspace;
		expect(renamed).toEqual({ ...workspace, name: "Friendly alias" });
		expect(existsSync(fx.project)).toBe(true);
		expect(fx.events.some((event) => event.event === "workspaces_changed")).toBe(true);
	});

	it("saves multiple Git outcomes and restores them through the transcript API", async () => {
		const fx = await start();
		const records = [
			{ tone: "ok", title: "Commit succeeded", hash: "abc1234", detail: "saved" },
			{ tone: "error", title: "Commit failed", detail: "hook failed" },
		];
		for (const record of records) {
			const saved = await fx.post("/api/git/record", record);
			expect(saved.id).toBeTruthy();
		}
		const transcript = await fx.get("/api/transcript");
		expect(
			transcript.items
				.filter((item: { kind: string }) => item.kind === "gitStatus")
				.map((item: { result: unknown }) => item.result),
		).toEqual(records);
		expect(
			fx.events.filter((event) => event.event === "entry_appended" && event.data.item?.kind === "gitStatus"),
		).toHaveLength(2);
	});

	it("exposes the real session state, models and workspace", async () => {
		const fx = await start();
		const state = await fx.get("/api/state");
		expect(state.model.provider).toBe(fx.faux.getModel().provider);
		expect(state.cwd).toBe(fx.project);
		expect(state.run.state).toBe("idle");
		expect(state.workspace.name).toBeTruthy();
		const models = await fx.get("/api/models");
		expect(models.providers.flatMap((provider: any) => provider.models.map((m: any) => m.id))).toContain(
			fx.faux.getModel().id,
		);
		const workspaces = await fx.get("/api/workspaces");
		expect(workspaces.workspaces.some((w: any) => w.current)).toBe(true);
	});

	it("runs a prompt through the real Agent loop, streams events and reports the file change with a diff", async () => {
		const fx = await start();
		writeFileSync(join(fx.project, "notes.txt"), "alpha\n");
		fx.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "notes.txt", content: "alpha\nbeta\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("All done.")]),
		]);
		await fx.post("/api/prompt", { text: "append beta to notes.txt" });
		const finished = await fx.waitFor("run_finished");
		expect(finished.outcome).toBe("completed");
		expect(finished.changeCount).toBe(1);
		expect(readFileSync(join(fx.project, "notes.txt"), "utf8")).toBe("alpha\nbeta\n");

		const names = new Set(fx.events.map((entry) => entry.event));
		for (const expected of [
			"agent_start",
			"message_start",
			"message_update",
			"message_end",
			"tool_start",
			"tool_end",
			"run_state",
			"agent_settled",
		]) {
			expect(names.has(expected)).toBe(true);
		}

		const transcript = await fx.get("/api/transcript");
		// The task's change card is an entry of the session, after the reply it belongs to.
		expect(transcript.items.map((item: any) => item.kind)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"runChanges",
		]);
		const card = transcript.items.at(-1);
		expect(card.files).toEqual([
			{ path: "notes.txt", status: "modified", additions: 1, deletions: 0, binary: false },
		]);

		const changes = await fx.get("/api/changes?scope=run");
		expect(changes.files).toHaveLength(1);
		expect(changes.files[0]).toMatchObject({ path: "notes.txt", status: "modified", additions: 1, deletions: 0 });
		const diff = await fx.get("/api/changes/diff?scope=run&path=notes.txt");
		expect(diff.patch).toContain("+beta");

		// While the task ran, the context use and the session's totals were pushed to the page.
		const usage = fx.events.filter((entry) => entry.event === "usage").at(-1)?.data as any;
		expect(usage.stats).toMatchObject({ userMessages: 1, assistantMessages: 2, toolCalls: 1 });
		expect(usage.stats.latestRequest.timing.requestMs).toBeGreaterThanOrEqual(0);
		expect(usage.stats.timing.toolMs.value).toBeGreaterThanOrEqual(0);
		const entries = fx.hub.get((await fx.get("/api/state")).slot)!.session.sessionManager.getEntries();
		expect(
			entries
				.filter((entry: any) => entry.type === "message" && entry.message.role === "assistant")
				.every((entry: any) => entry.timing?.requestMs >= 0),
		).toBe(true);
		expect(usage.context.budget.activeTokens).toBeGreaterThan(0);

		// A second task in the same chat: the first card stays and still shows its own diff, the new card holds only
		// what the second task changed.
		// The session takes the next prompt once it has closed the run, a moment after `run_finished` is sent.
		await new Promise((resolve) => setTimeout(resolve, 500));
		const seen = fx.events.length;
		fx.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "notes.txt", content: "alpha\nbeta\ngamma\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("Done again.")]),
		]);
		await fx.post("/api/prompt", { text: "append gamma to notes.txt" });
		await vi.waitFor(() => expect(fx.events.slice(seen).some((entry) => entry.event === "run_finished")).toBe(true), {
			timeout: 30_000,
		});
		const after = await fx.get("/api/transcript");
		const cards = after.items.filter((item: any) => item.kind === "runChanges");
		expect(cards).toHaveLength(2);
		expect(cards[0].id).toBe(card.id);
		expect(after.items.at(-1)).toBe(cards[1]);
		const firstDiff = await fx.get(`/api/changes/card-diff?id=${cards[0].id}&path=notes.txt`);
		expect(firstDiff.patch).toContain("+beta");
		expect(firstDiff.patch).not.toContain("gamma");
		const secondDiff = await fx.get(`/api/changes/card-diff?id=${cards[1].id}&path=notes.txt`);
		expect(secondDiff.patch).toContain("+gamma");
		expect(secondDiff.patch).not.toContain("+beta");
		expect(secondDiff.summary).toMatchObject({ additions: 1, deletions: 0 });
	});

	it("does not repeat uncommitted changes in read-only follow-ups and isolates later task diffs", async () => {
		const fx = await start();
		writeFileSync(join(fx.project, "notes.txt"), "alpha\n");
		expect(initializeGitRepository(fx.project).ok).toBe(true);
		expect(setLocalGitIdentity(fx.project, { name: "Web test", email: "web@example.invalid" }).ok).toBe(true);
		expect(createInitialGitBaseline(fx.project).ok).toBe(true);
		const owner = fx.hub.get((await fx.get("/api/state")).slot)!;
		owner.session.settingsManager.setGitIntegrationEnabled(true);
		owner.session.settingsManager.setAutoMemorySettings({ enabled: false });
		await owner.session.settingsManager.flush();

		const run = async (responses: Parameters<typeof fx.faux.setResponses>[0], text: string) => {
			const seen = fx.events.length;
			fx.faux.setResponses(responses);
			await fx.post("/api/prompt", { text });
			await vi.waitFor(
				() => expect(fx.events.slice(seen).some((event) => event.event === "run_finished")).toBe(true),
				{
					timeout: 30_000,
				},
			);
			await owner.waitForCompletion();
			await owner.session.waitForIdle();
			return fx.events.slice(seen).find((event) => event.event === "run_finished")!.data;
		};
		const cards = async () =>
			(await fx.get("/api/transcript")).items.filter((item: any) => item.kind === "runChanges");

		await run(
			[
				fauxAssistantMessage([fauxToolCall("write", { path: "notes.txt", content: "alpha\nbeta\n" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxText("Done.")]),
			],
			"append beta",
		);
		const firstCheckpoint = owner.session.getGitCheckpoint()!;
		expect(firstCheckpoint).toBeDefined();
		expect(firstCheckpoint.status).toBe("created");
		const firstCards = await cards();
		expect(firstCards).toHaveLength(1);

		for (const text of ["what changed?", "explain again"]) {
			const finished = await run([fauxAssistantMessage([fauxText("Only explaining.")])], text);
			expect(finished.changeCount).toBe(0);
			expect(await cards()).toEqual(firstCards);
			expect(owner.openCheckpoint()).toBe(firstCheckpoint);
			expect(readFileSync(join(fx.project, "notes.txt"), "utf8")).toBe("alpha\nbeta\n");
		}

		await run(
			[
				fauxAssistantMessage([fauxToolCall("write", { path: "notes.txt", content: "alpha\nbeta\ngamma\n" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxText("Done again.")]),
			],
			"append gamma",
		);
		expect(owner.session.getGitCheckpoint()!.id).not.toBe(firstCheckpoint.id);
		const after = await cards();
		expect(after).toHaveLength(2);
		expect(after[0]).toEqual(firstCards[0]);
		const diff = await fx.get(`/api/changes/card-diff?id=${after[1].id}&path=notes.txt`);
		expect(diff.patch).toContain("+gamma");
		expect(diff.patch).not.toContain("+beta");
		expect(diff.summary).toMatchObject({ additions: 1, deletions: 0 });
		// Undo the latest task leaves the earlier, still uncommitted change intact.
		await fx.post("/api/git/undo/restore");
		expect(readFileSync(join(fx.project, "notes.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("alpha\nbeta\n");
	}, 90_000);

	it("marks a run whose provider fails as failed and keeps the error", async () => {
		const fx = await start();
		fx.faux.setResponses([
			fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "provider exploded" }),
		]);
		await fx.post("/api/prompt", { text: "hello" });
		const finished = await fx.waitFor("run_finished", undefined, 30_000);
		expect(["failed", "partial"]).toContain(finished.outcome);
		expect(finished.changeCount).toBe(0);
		const transcript = await fx.get("/api/transcript");
		const last = transcript.items[transcript.items.length - 1];
		// The error is explained (cause and next step) and keeps the raw provider text for troubleshooting.
		expect(last).toMatchObject({ kind: "assistant", stopReason: "error" });
		expect(last.error).toMatch(/^模型请求失败：.*\n原始信息：provider exploded$/s);
	});

	it("serves workspace files safely and refuses paths outside the workspace", async () => {
		const fx = await start();
		writeFileSync(join(fx.project, "a.ts"), "export const a = 1;\n");
		mkdirSync(join(fx.project, "src"));
		const listing = await fx.get("/api/files/list?dir=");
		expect(listing.entries.map((entry: any) => entry.name).sort()).toEqual(["a.ts", "src"]);
		const file = await fx.get("/api/files/read?path=a.ts");
		expect(file).toMatchObject({ kind: "text", language: "typescript" });
		await expect(fx.get("/api/files/read?path=..%2F..%2Fsecret")).rejects.toThrow(/outside the workspace/);
		const found = await fx.get("/api/files/search?q=a.t");
		expect(found.files).toContain("a.ts");
	});

	it("switches a language module on and off without touching its other settings", async () => {
		const fx = await start();
		const python = async () =>
			(await fx.get("/api/code-intelligence/modules")).modules.find((module: any) => module.id === "python");
		expect(await python()).toMatchObject({ enabled: true, serverKey: "pyright" });
		expect(
			(await fx.post("/api/code-intelligence/language", { id: "python", enabled: false })).modules.find(
				(module: any) => module.id === "python",
			).enabled,
		).toBe(false);
		expect(await python()).toMatchObject({ enabled: false });
		await fx.post("/api/code-intelligence/language", { id: "python", enabled: true });
		expect(await python()).toMatchObject({ enabled: true });
		await expect(fx.post("/api/code-intelligence/language", { id: "nope", enabled: false })).rejects.toThrow(
			/Unknown language module/,
		);
	});

	it("lists settings, resources and providers and validates setting writes", async () => {
		const fx = await start();
		const settings = await fx.get("/api/settings");
		expect(settings.items.find((item: any) => item.id === "steeringMode")).toBeTruthy();
		await expect(fx.post("/api/settings", { id: "nope", value: 1 })).rejects.toThrow(/Unknown setting/);
		// Every setting the UI lists must accept its own current value.
		for (const item of settings.items) {
			await fx.post("/api/settings", { id: item.id, value: item.value });
		}
		for (const value of [0, 1, 2, 3006]) {
			await fx.post("/api/settings", { id: "webShutdownGraceSeconds", value });
			expect(
				(await fx.get("/api/settings")).items.find((item: any) => item.id === "webShutdownGraceSeconds").value,
			).toBe(value);
		}
		for (const [id, min, max] of [
			["webSearch.pagesPerSearch", 0, 10],
			["webSearch.maxUrlsPerFetch", 1, 20],
			["webSearch.fetchConcurrency", 1, 8],
		] as const) {
			expect(settings.items.find((item: any) => item.id === id)).toMatchObject({ min, max });
			await expect(fx.post("/api/settings", { id, value: max + 1 })).rejects.toThrow();
		}
		await fx.post("/api/settings", { id: "steeringMode", value: "all" });
		expect((await fx.get("/api/state")).queueModes.steering).toBe("all");
		const resources = await fx.get("/api/resources");
		expect(resources.tools.map((tool: any) => tool.name)).toContain("read");
		expect(resources.commands.some((command: any) => command.name === "compact")).toBe(true);
		const providers = await fx.get("/api/providers");
		expect(providers.providers.length).toBeGreaterThan(0);
		// Credentials never leave the server: no key material in the provider listing.
		expect(JSON.stringify(providers)).not.toContain("faux-key");
	});

	it("supports session creation, renaming, listing and the branch tree", async () => {
		const fx = await start();
		fx.faux.setResponses([fauxAssistantMessage([fauxText("hi there")])]);
		await fx.post("/api/prompt", { text: "first message" });
		await fx.waitFor("run_finished");
		const before = await fx.get("/api/state");
		const sessions = await fx.get(`/api/workspaces/sessions?path=${encodeURIComponent(fx.project)}`);
		expect(sessions.sessions.some((s: any) => s.current)).toBe(true);
		const tree = await fx.get("/api/sessions/tree");
		expect(tree.rows.some((row: any) => row.kind === "user")).toBe(true);
		await fx.post("/api/sessions/rename", { path: before.session.file, title: "Renamed chat" });
		expect((await fx.get("/api/state")).session.name).toBe("Renamed chat");
		// A new chat opens next to the existing one; the first chat keeps its content and slot.
		const created = await fx.post("/api/sessions/new", {});
		expect(created.created).toBe(true);
		expect(created.slot).not.toBe(before.slot);
		const after = await fx.get("/api/state", created.slot);
		expect(after.session.id).not.toBe(before.session.id);
		expect((await fx.get("/api/transcript", created.slot)).items).toHaveLength(0);
		expect((await fx.get("/api/transcript", before.slot)).items.length).toBeGreaterThan(0);
		// An untouched empty chat is reused instead of piling up more empty ones.
		expect((await fx.post("/api/sessions/new", {}, created.slot)).slot).toBe(created.slot);
		// Opening a chat that is already loaded returns its slot instead of loading it twice.
		const reopened = await fx.post("/api/sessions/open", { path: before.session.file }, created.slot);
		expect(reopened).toEqual({ slot: before.slot, created: false });
	});

	it("runs agents in several sessions at the same time without mixing their events", async () => {
		const fx = await start();
		const first = await fx.get("/api/state");
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		fx.faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage([fauxText("slow answer")]);
			},
		]);
		void fx.post("/api/prompt", { text: "slow task" }, first.slot);
		await fx.waitFor("agent_start", (data) => data.slot === first.slot);
		expect((await fx.get("/api/state", first.slot)).active).toBe(true);
		const other = await fx.post("/api/sessions/new", {}, first.slot);
		expect(other.slot).not.toBe(first.slot);
		fx.faux.appendResponses([fauxAssistantMessage([fauxText("fast answer")])]);
		await fx.post("/api/prompt", { text: "fast task" }, other.slot);
		await fx.waitFor("run_finished", (data) => data.slot === other.slot);
		// The slow session is still running while the second one has already finished.
		expect((await fx.get("/api/state", first.slot)).active).toBe(true);
		expect((await fx.get("/api/state", other.slot)).active).toBe(false);
		release();
		await fx.waitFor("run_finished", (data) => data.slot === first.slot);
		const texts = (slot: string) =>
			fx
				.get("/api/transcript", slot)
				.then((t: any) =>
					t.items.flatMap((item: any) =>
						item.kind === "assistant"
							? item.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text)
							: [],
					),
				);
		expect(await texts(first.slot)).toEqual(["slow answer"]);
		expect(await texts(other.slot)).toEqual(["fast answer"]);
		const slots = (await fx.get("/api/slots")).slots;
		expect(slots.map((s: any) => s.slot).sort()).toEqual([first.slot, other.slot].sort());
	});

	it("keeps a finished session unread per session until the browser reports it seen", async () => {
		const fx = await start();
		const first = await fx.get("/api/state");
		fx.faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
		await fx.post("/api/prompt", { text: "task one" }, first.slot);
		await fx.waitFor("run_finished", (data) => data.slot === first.slot);
		const other = await fx.post("/api/sessions/new", {}, first.slot);
		expect(other.slot).not.toBe(first.slot);
		const slotOf = async (id: string) => (await fx.get("/api/slots")).slots.find((s: any) => s.slot === id);
		expect((await slotOf(first.slot)).unread).toBe(true);
		// Another session finishing or being read never changes this one.
		expect((await slotOf(other.slot)).unread).toBe(false);
		await fx.post("/api/prompt", { text: "task two" }, other.slot);
		await fx.waitFor("run_finished", (data) => data.slot === other.slot);
		await fx.post("/api/seen", {}, other.slot);
		expect((await slotOf(other.slot)).unread).toBe(false);
		expect((await slotOf(first.slot)).unread).toBe(true);
		await fx.post("/api/seen", {}, first.slot);
		expect((await slotOf(first.slot)).unread).toBe(false);
		await fx.waitFor("result_seen", (data) => data.slot === first.slot);
	});

	it("announces the end of a task to the open page and shows the system popup when the page cannot", async () => {
		const fx = await start();
		const announced = () => fx.events.filter((entry) => entry.event === "task_notification").map((e) => e.data);
		// The popups of this test's own project: one that an earlier test left unanswered may still follow meanwhile.
		const popups = () =>
			showPopupMock.mock.calls.map(([, content]) => content).filter((c) => c.title.endsWith(basename(fx.project)));
		// Every task runs in a chat of its own, and returns that chat's slot once the run has ended.
		let slot: string = (await fx.get("/api/state")).slot;
		const run = async (text: string) => {
			if (fx.events.some((entry) => entry.event === "run_finished" && entry.data.slot === slot))
				slot = (await fx.post("/api/sessions/new", {}, slot)).slot;
			const ran = slot;
			await fx.post("/api/prompt", { text }, ran);
			await fx.waitFor("run_finished", (data) => data.slot === ran);
			await fx.waitFor("run_state", (data) => data.slot === ran && ["completed", "failed"].includes(data.state));
			return ran;
		};
		fx.faux.setResponses([
			fauxAssistantMessage([fauxText("one")]),
			fauxAssistantMessage([fauxText("two")]),
			fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "provider exploded" }),
			fauxAssistantMessage([fauxText("four")]),
		]);

		// The page is asked first; nothing is shown by the server while it may still answer.
		const one = await run("task one");
		const first = await fx.waitFor("task_notification", (data) => data.slot === one);
		expect(first).toMatchObject({ kind: "completed", state: "completed" });
		expect(popups()).toHaveLength(0);
		// The page's browser will not show notifications: the system popup is shown at once, and only once.
		await fx.post("/api/notifications/answer", { id: first.id, shown: false }, one);
		expect(popups()).toHaveLength(1);
		expect(popups()[0]).toMatchObject({ kind: "completed" });
		expect(popups()[0].title).toContain("MyHarness");
		await fx.post("/api/notifications/answer", { id: first.id, shown: false }, one);
		expect(popups()).toHaveLength(1);

		// The page showed the notification itself: no popup, also not later.
		const two = await run("task two");
		const second = await fx.waitFor("task_notification", (data) => data.slot === two);
		await fx.post("/api/notifications/answer", { id: second.id, shown: true }, two);
		await fx.post("/api/notifications/answer", { id: second.id, shown: false }, two);
		expect(popups()).toHaveLength(1);

		// A page that never answers: the popup follows by itself, with the failure it is about.
		const three = await run("task three");
		const third = await fx.waitFor("task_notification", (data) => data.slot === three);
		expect(third).toMatchObject({ kind: "failed", state: "failed" });
		expect(third.error).toMatch(/^模型请求失败：.*原始信息：provider exploded$/s);
		await vi.waitFor(() => expect(popups()).toHaveLength(2), { timeout: 6000, interval: 100 });
		expect(popups()[1]).toMatchObject({ kind: "failed" });
		expect(popups()[1].message).toContain("provider exploded");

		// With the setting off nothing is announced.
		await fx.post("/api/settings", { id: "popupNotifications", value: false }, three);
		const four = await run("task four");
		expect(announced().map((notice) => notice.slot)).toEqual([one, two, three]);
		expect(four).not.toBe(three);
		expect(popups()).toHaveLength(2);
	});

	it("applies a saved project trust decision to the open chat at once", async () => {
		const fx = await start();
		mkdirSync(join(fx.project, ".myharness"));
		writeFileSync(join(fx.project, ".myharness", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 12345 }));
		const httpIdleTimeout = async () =>
			(await fx.get("/api/settings")).items.find((item: any) => item.id === "httpIdleTimeoutMs").value;

		expect(await fx.post("/api/trust", { option: "do-not-trust" })).toMatchObject({ ok: true, trusted: false });
		expect(await fx.get("/api/trust")).toMatchObject({ requiresTrust: true, trusted: false, saved: false });
		expect((await fx.get("/api/state")).trust).toEqual({ trusted: false, requiresTrust: true });
		expect(await httpIdleTimeout()).not.toBe("12345");

		// Trusting the project loads its own settings into the chat that is open.
		expect(await fx.post("/api/trust", { option: "trust" })).toMatchObject({ ok: true, trusted: true });
		expect(await fx.get("/api/trust")).toMatchObject({ trusted: true, saved: true });
		expect(await httpIdleTimeout()).toBe("12345");
		await expect(fx.post("/api/trust", { option: "nope" })).rejects.toThrow(/Unknown trust option/);
	});

	it("adds a custom provider with detected models, keeps its key in the credential store and deletes both for good", async () => {
		const fx = await start();
		// Every model a probe request was sent for: only the Model IDs the user named may appear here.
		const probed: string[] = [];
		const catalog = createServer((req, res) => {
			if (req.method === "POST") {
				// Probe of a named model's thinking levels: a rate limit leaves them undecided, however often it is tried.
				let body = "";
				req.on("data", (chunk) => {
					body += chunk;
				});
				req.on("end", () => {
					probed.push(JSON.parse(body).model);
					res.statusCode = 429;
					res.end("{}");
				});
				return;
			}
			expect(req.headers.authorization).toBe("Bearer sk-form-key");
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					data: [
						{
							id: "thinker",
							context_length: 32000,
							supported_parameters: ["reasoning"],
							architecture: { input_modalities: ["text", "image"] },
						},
						{ id: "plain" },
					],
				}),
			);
		});
		await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => new Promise<void>((resolve) => catalog.close(() => resolve())));
		const address = catalog.address();
		if (!address || typeof address === "string") throw new Error("catalog server has no port");
		const baseUrl = `http://127.0.0.1:${address.port}/v1`;

		// Nothing is detected without Model IDs.
		await expect(
			fx.post("/api/providers/custom/detect", { baseUrl, api: "openai-completions", apiKey: "sk-form-key" }),
		).rejects.toThrow(/Model ID/);
		expect(probed).toEqual([]);

		// Only the named model comes back and only it is probed, although the list holds another one.
		const detected = await fx.post("/api/providers/custom/detect", {
			baseUrl,
			api: "openai-completions",
			apiKey: "sk-form-key",
			modelIds: ["thinker"],
		});
		expect(detected).toMatchObject({ ok: true, unlisted: [], listError: null });
		expect(detected.models).toEqual([
			{
				id: "thinker",
				name: "thinker",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 32000,
				// Undecided is not "unsupported": no level is hidden, and the opt-in levels stay selectable.
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				thinkingLevelStatus: {
					minimal: "unknown",
					low: "unknown",
					medium: "unknown",
					high: "unknown",
					xhigh: "unknown",
					max: "unknown",
				},
				thinkingSource: "unconfirmed",
			},
		]);
		// Each level is asked on its own: once, then up to three more times while the answer is undecided.
		expect(probed).toHaveLength(6 * 4);
		expect(new Set(probed)).toEqual(new Set(["thinker"]));

		// An ID the list does not name is still checked, and reported as not listed.
		probed.length = 0;
		const ghost = await fx.post("/api/providers/custom/detect", {
			baseUrl,
			api: "openai-completions",
			apiKey: "sk-form-key",
			modelIds: ["ghost"],
		});
		expect(ghost).toMatchObject({ ok: true, unlisted: ["ghost"], models: [{ id: "ghost", name: "ghost" }] });
		expect(new Set(probed)).toEqual(new Set(["ghost"]));

		// A model list that cannot be read is reported next to the (still attempted) check of the named model.
		const unreachable = await fx.post("/api/providers/custom/detect", {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			modelIds: ["x"],
		});
		expect(unreachable.ok).toBe(true);
		expect(unreachable.listError).toMatchObject({ code: "connection" });
		// Nothing could be asked, so nothing is settled: every level is undecided, none is reported as unsupported.
		expect(unreachable.models).toMatchObject([{ id: "x", name: "x" }]);
		expect(new Set(Object.values(unreachable.models[0].thinkingLevelStatus))).toEqual(new Set(["unknown"]));
		expect(unreachable.models[0].reasoning).toBeUndefined();

		await fx.post("/api/providers/custom/save", {
			id: "form-provider",
			config: {
				name: "Form provider",
				baseUrl,
				api: "openai-completions",
				models: [
					{
						id: "thinker",
						reasoning: true,
						thinkingLevelMap: { minimal: null },
						input: ["text"],
						contextWindow: 32000,
						maxTokens: 4096,
					},
				],
			},
			apiKey: "sk-form-key",
		});
		const custom = await fx.get("/api/providers/custom");
		expect(custom.providers.map((p: any) => p.id)).toEqual(["form-provider"]);
		expect(JSON.stringify(custom)).not.toContain("sk-form-key");
		const listed = (await fx.get("/api/providers")).providers.find((p: any) => p.id === "form-provider");
		expect(listed.credentials.apiKeys).toHaveLength(1);
		expect(listed.modelCount).toBe(1);

		// The last custom provider can be deleted, and nothing of it is left afterwards.
		await fx.post("/api/providers/custom/delete", { id: "form-provider" });
		expect((await fx.get("/api/providers/custom")).providers).toEqual([]);
		expect((await fx.get("/api/providers")).providers.some((p: any) => p.id === "form-provider")).toBe(false);
		await expect(fx.post("/api/providers/custom/delete", { id: "form-provider" })).rejects.toThrow(
			/No such provider/,
		);
	});

	/** A local HTTP server standing in for a provider endpoint. */
	async function startEndpoint(
		handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
	): Promise<{ baseUrl: string; requests: Array<{ url: string; authorization?: string }> }> {
		const requests: Array<{ url: string; authorization?: string }> = [];
		const endpoint = createServer((req, res) => {
			requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
			handler(req, res);
		});
		await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => {
			endpoint.closeAllConnections();
			return new Promise<void>((resolve) => endpoint.close(() => resolve()));
		});
		const address = endpoint.address();
		if (!address || typeof address === "string") throw new Error("endpoint has no port");
		return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
	}

	it("detects models with the unsaved form state and reports why a detection failed", async () => {
		const fx = await start();
		const endpoint = await startEndpoint((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url?.startsWith("/v1/models")) {
				if (req.headers.authorization === "Bearer typed-key") {
					res.end(JSON.stringify({ data: [{ id: "one" }] }));
				} else if (req.headers.authorization === "Bearer bad") {
					res.statusCode = 401;
					res.end("{}");
				} else if (req.headers.authorization === "Bearer broken") {
					res.statusCode = 503;
					res.end("{}");
				} else {
					res.end(JSON.stringify({ data: [{ id: "open-model" }] }));
				}
				return;
			}
			res.statusCode = 404;
			res.end("{}");
		});
		const body = { baseUrl: endpoint.baseUrl, api: "openai-completions", modelIds: ["one"] };

		// Credentials typed into the form are used as they are.
		const typed = await fx.post("/api/providers/custom/detect", { ...body, apiKey: "typed-key" });
		expect(typed).toMatchObject({ ok: true, unlisted: [], listError: null, models: [{ id: "one", name: "one" }] });
		// A key written in models.json (not saved yet) is used when that is the chosen way to authenticate.
		await fx.post("/api/providers/custom/detect", { ...body, auth: "config", configApiKey: "from-config" });
		expect(endpoint.requests.at(-1)?.authorization).toBe("Bearer from-config");

		// Each failure to read the list says what really happened.
		expect((await fx.post("/api/providers/custom/detect", { ...body, apiKey: "bad" })).listError).toMatchObject({
			code: "authentication",
			status: 401,
		});
		expect((await fx.post("/api/providers/custom/detect", { ...body, apiKey: "broken" })).listError).toMatchObject({
			code: "connection",
			status: 503,
		});
		const wrongPath = await fx.post("/api/providers/custom/detect", {
			...body,
			baseUrl: endpoint.baseUrl.replace("/v1", "/nope"),
			apiKey: "typed-key",
		});
		expect(wrongPath.listError).toMatchObject({ code: "unsupported", status: 404 });
		expect(wrongPath.listError.url).toMatch(/\/nope\/models$/);
		const refused = await fx.post("/api/providers/custom/detect", { ...body, baseUrl: "http://127.0.0.1:9/v1" });
		expect(refused.listError).toMatchObject({ code: "connection" });
		expect(refused.listError.detail).toBeTruthy();
		expect(
			(await fx.post("/api/providers/custom/detect", { ...body, baseUrl: "not a url" })).listError,
		).toMatchObject({
			code: "invalid_base_url",
		});
	});

	it("removes credentials for real, including a key written into models.json", async () => {
		const fx = await start();
		const agentDir = process.env.MYHARNESS_CODING_AGENT_DIR as string;
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					literal: {
						name: "Literal",
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "literal-secret",
						models: [{ id: "lit" }],
					},
					local: {
						name: "Local",
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "local",
						models: [{ id: "loc" }],
					},
				},
			}),
		);
		await fx.post("/api/providers/custom/save", {
			id: "literal",
			previousId: "literal",
			config: {
				name: "Literal",
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				apiKey: "__hidden__",
				models: [{ id: "lit" }],
			},
		});
		let providers = (await fx.get("/api/providers")).providers;
		expect(providers.find((p: any) => p.id === "literal")).toMatchObject({
			configured: true,
			credentials: { removable: true },
		});
		// "local" means "no authentication": there is no credential to remove.
		expect(providers.find((p: any) => p.id === "local").credentials.removable).toBe(false);

		await fx.post("/api/providers/logout", { id: "literal" });
		providers = (await fx.get("/api/providers")).providers;
		expect(providers.find((p: any) => p.id === "literal")).toMatchObject({
			configured: false,
			credentials: { removable: false },
		});
		expect(readFileSync(modelsPath, "utf8")).not.toContain("literal-secret");
		if (existsSync(`${modelsPath}.bak`))
			expect(readFileSync(`${modelsPath}.bak`, "utf8")).not.toContain("literal-secret");
		// The rest of the provider is untouched.
		const config = (await fx.get("/api/providers/custom")).providers.find((p: any) => p.id === "literal").config;
		expect(config).toMatchObject({ name: "Literal", models: [{ id: "lit" }] });

		// Saved keys are removed too.
		await fx.post("/api/providers/api-key/add", { id: "literal", key: "stored-key", label: "k" });
		expect(
			(await fx.get("/api/providers")).providers.find((p: any) => p.id === "literal").credentials.removable,
		).toBe(true);
		await fx.post("/api/providers/logout", { id: "literal" });
		expect((await fx.get("/api/providers")).providers.find((p: any) => p.id === "literal")).toMatchObject({
			configured: false,
			credentials: { apiKeys: [], removable: false },
		});
	});

	it("saves a provider without a Base URL but keeps it off until one is filled in, and remembers how it authenticates", async () => {
		const fx = await start();
		const modelsPath = join(process.env.MYHARNESS_CODING_AGENT_DIR as string, "models.json");
		const find = async () => (await fx.get("/api/providers")).providers.find((p: any) => p.id === "relay");
		const offered = async () => (await fx.get("/api/models")).providers.map((p: any) => p.id);
		const config = { name: "Relay", api: "openai-completions", models: [{ id: "m1" }] };

		// No Base URL yet: saved as it is (no example address is written), but not usable.
		const saved = await fx.post("/api/providers/custom/save", {
			id: "relay",
			config: { ...config, authMode: "apiKey" },
			apiKey: "sk-relay",
		});
		expect(saved).toMatchObject({ ok: true, missingBaseUrl: true });
		expect(JSON.parse(readFileSync(modelsPath, "utf8")).providers.relay.baseUrl).toBeUndefined();
		expect(await find()).toMatchObject({ missingBaseUrl: true, enabled: false });
		expect(await offered()).not.toContain("relay");
		await expect(fx.post("/api/providers/enabled", { id: "relay", enabled: true })).rejects.toThrow(/^409/);

		// Filling it in is all it takes; the key written in models.json is the chosen way to authenticate.
		const filled = await fx.post("/api/providers/custom/save", {
			id: "relay",
			previousId: "relay",
			config: { ...config, baseUrl: "http://127.0.0.1:9/v1", authMode: "config", apiKey: "cfg-key" },
		});
		expect(filled).toMatchObject({ ok: true, missingBaseUrl: false });
		expect(await find()).toMatchObject({ missingBaseUrl: false, enabled: true, configured: true, modelCount: 1 });
		expect(await offered()).toContain("relay");
		const custom = (await fx.get("/api/providers/custom")).providers.find((p: any) => p.id === "relay");
		expect(custom.config.authMode).toBe("config");
		expect(JSON.stringify(custom)).not.toContain("cfg-key");

		// Clearing the Base URL of a provider in use is allowed: it is saved and the provider goes off.
		const cleared = await fx.post("/api/providers/custom/save", {
			id: "relay",
			previousId: "relay",
			config: { ...config, baseUrl: "", authMode: "config", apiKey: "__hidden__" },
		});
		expect(cleared).toMatchObject({ ok: true, missingBaseUrl: true });
		expect(await find()).toMatchObject({ missingBaseUrl: true, enabled: false });
		expect(await offered()).not.toContain("relay");
		const kept = JSON.parse(readFileSync(modelsPath, "utf8")).providers.relay;
		expect(kept).toMatchObject({ authMode: "config", apiKey: "cfg-key" });
		expect(kept.baseUrl).toBeUndefined();
	});

	it("asks before deleting a provider that running tasks use, and stops them when told to", async () => {
		const fx = await start();
		// A chat completion that never answers keeps the task running until it is aborted.
		const endpoint = await startEndpoint(() => {});
		await fx.post("/api/providers/custom/save", {
			id: "slow",
			config: {
				name: "Slow",
				baseUrl: endpoint.baseUrl,
				api: "openai-completions",
				models: [{ id: "slow-1", contextWindow: 10_000_000, maxTokens: 1000 }],
			},
			apiKey: "key",
		});
		await fx.post("/api/model", { provider: "slow", id: "slow-1" });
		expect((await fx.get("/api/providers/custom/usage?id=slow")).running).toEqual([]);

		await fx.post("/api/prompt", { text: "work for a long time" });
		await fx.waitFor("agent_start");
		const usage = await fx.get("/api/providers/custom/usage?id=slow");
		expect(usage.running).toHaveLength(1);

		// Without the explicit choice nothing is deleted and nothing is stopped.
		const refused = await fx.post("/api/providers/custom/delete", { id: "slow" });
		expect(refused).toMatchObject({ ok: false });
		expect(refused.running).toHaveLength(1);
		expect((await fx.get("/api/providers/custom")).providers.map((p: any) => p.id)).toEqual(["slow"]);
		expect((await fx.get("/api/state")).active).toBe(true);

		// "Delete now" stops the task, then deletes the provider, its key and every reference to it.
		expect(await fx.post("/api/providers/custom/delete", { id: "slow", stopRunning: true })).toEqual({ ok: true });
		const state = await fx.get("/api/state");
		expect(state.active).toBe(false);
		expect((await fx.get("/api/providers/custom")).providers).toEqual([]);
		expect((await fx.get("/api/providers")).providers.some((p: any) => p.id === "slow")).toBe(false);
		expect(state.model?.provider).not.toBe("slow");
	});

	it("removes the current (last) workspace without touching the folder or the chats, which stay usable", async () => {
		const fx = await start();
		fx.faux.setResponses([fauxAssistantMessage([fauxText("first answer")])]);
		await fx.post("/api/prompt", { text: "remember this" });
		await fx.waitFor("run_finished");
		writeFileSync(join(fx.project, "keep.txt"), "project file");
		const before = await fx.get("/api/state");
		// The data root is shared by the tests of this file: drop the workspaces of earlier tests so this one is the last.
		const listed = (await fx.get("/api/workspaces")).workspaces;
		for (const other of listed.filter((w: any) => !w.current))
			await fx.post("/api/workspaces/remove", { id: other.id });
		const workspace = (await fx.get("/api/workspaces")).workspaces;
		expect(workspace).toHaveLength(1);
		expect(workspace[0].current).toBe(true);

		await fx.post("/api/workspaces/remove", { id: workspace[0].id });
		expect((await fx.get("/api/workspaces")).workspaces).toEqual([]);
		// The folder and the chat file stay exactly where they were.
		expect(readFileSync(join(fx.project, "keep.txt"), "utf8")).toBe("project file");
		expect(existsSync(before.session.file)).toBe(true);
		// The open chat is now workspace-less but keeps running; the UI sees it as such.
		const after = await fx.get("/api/state");
		expect(after.workspace).toBeNull();
		expect(after.session.file).toBe(before.session.file);
		const unbound = await fx.get("/api/sessions/unbound");
		expect(unbound.sessions.map((s: any) => s.path)).toContain(before.session.file);
		expect(unbound.sessions.find((s: any) => s.path === before.session.file).firstMessage).toBe("remember this");
		// Nothing lists it under a workspace any more.
		expect((await fx.get(`/api/workspaces/sessions?path=${encodeURIComponent(fx.project)}`)).sessions).toEqual([]);

		// The chat continues after the workspace is gone, in its own folder.
		fx.faux.setResponses([fauxAssistantMessage([fauxText("second answer")])]);
		await fx.post("/api/prompt", { text: "and again" });
		await vi.waitFor(
			async () => {
				expect((await fx.get("/api/state")).active).toBe(false);
				const transcript = await fx.get("/api/transcript");
				expect(transcript.items.filter((item: any) => item.kind === "user")).toHaveLength(2);
				expect(transcript.items.filter((item: any) => item.kind === "assistant")).toHaveLength(2);
			},
			{ timeout: 15_000 },
		);

		// The chat can be closed and opened again from the workspace-less list.
		const other = await fx.post("/api/sessions/new", { unbound: true });
		expect(other.created).toBe(true);
		const reopened = await fx.post("/api/sessions/open", { path: before.session.file }, other.slot);
		expect(reopened.slot).toBe(before.slot);

		// Adding the same folder again reattaches the chats that stayed behind.
		await fx.post("/api/workspaces/add", { path: fx.project });
		const restored = await fx.get(`/api/workspaces/sessions?path=${encodeURIComponent(fx.project)}`);
		expect(restored.sessions.map((s: any) => s.path)).toContain(before.session.file);
		expect((await fx.get("/api/sessions/unbound")).sessions.map((s: any) => s.path)).not.toContain(
			before.session.file,
		);
	});

	it("creates and runs chats that belong to no workspace in MyHarness's default working directory", async () => {
		const fx = await start();
		const agentDir = process.env.MYHARNESS_CODING_AGENT_DIR as string;
		// No workspace at all, yet a new chat can still be started.
		const { workspaces } = await fx.get("/api/workspaces");
		for (const workspace of workspaces) await fx.post("/api/workspaces/remove", { id: workspace.id });
		const created = await fx.post("/api/sessions/new", { unbound: true });
		expect(created.created).toBe(true);
		const state = await fx.get("/api/state", created.slot);
		expect(state.workspace).toBeNull();
		expect(state.cwd).toBe(join(agentDir, "default-workspace"));
		expect(existsSync(state.cwd)).toBe(true);
		expect((await fx.get("/api/workspaces")).workspaces).toEqual([]);

		// Tools and the shell work there.
		fx.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "scratch.txt", content: "hello" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("written")]),
		]);
		await fx.post("/api/prompt", { text: "write a scratch file" }, created.slot);
		await vi.waitFor(
			async () => {
				expect(existsSync(join(state.cwd, "scratch.txt"))).toBe(true);
				expect((await fx.get("/api/state", created.slot)).active).toBe(false);
			},
			{ timeout: 15_000 },
		);
		expect(readFileSync(join(state.cwd, "scratch.txt"), "utf8")).toBe("hello");
		const started = await fx.post("/api/bash", { command: "echo unbound-shell" }, created.slot);
		const end = await fx.waitFor("bash_end", (data) => data.id === started.id);
		expect(end.output).toContain("unbound-shell");

		// The chat is listed among the workspace-less chats and never registered a workspace.
		const unbound = (await fx.get("/api/sessions/unbound")).sessions;
		expect(unbound.map((s: any) => s.path)).toContain(state.session.file);
		expect((await fx.get("/api/workspaces")).workspaces).toEqual([]);

		// "New chat" from a workspace-less chat stays workspace-less and does not fall back to the old folder.
		const next = await fx.post("/api/sessions/new", {}, created.slot);
		const nextState = await fx.get("/api/state", next.slot);
		expect(nextState.workspace).toBeNull();
		expect(nextState.cwd).toBe(state.cwd);
	});

	it("runs direct shell commands and streams their output", async () => {
		const fx = await start();
		const started = await fx.post("/api/bash", { command: "echo web-ui-shell", excludeFromContext: false });
		const end = await fx.waitFor("bash_end", (data) => data.id === started.id);
		expect(end.output).toContain("web-ui-shell");
		expect(end.exitCode).toBe(0);
	});
});
