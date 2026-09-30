import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@myharness/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/agent/runtime/session-runtime.ts";
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

interface Fixture {
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
		registerProviderRoutes(server, host);
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
		expect(transcript.items.map((item: any) => item.kind)).toEqual(["user", "assistant", "toolResult", "assistant"]);

		const changes = await fx.get("/api/changes?scope=run");
		expect(changes.files).toHaveLength(1);
		expect(changes.files[0]).toMatchObject({ path: "notes.txt", status: "modified", additions: 1, deletions: 0 });
		const diff = await fx.get("/api/changes/diff?scope=run&path=notes.txt");
		expect(diff.patch).toContain("+beta");
	});

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
		expect(last).toMatchObject({ kind: "assistant", stopReason: "error", error: "provider exploded" });
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

	it("lists settings, resources and providers and validates setting writes", async () => {
		const fx = await start();
		const settings = await fx.get("/api/settings");
		expect(settings.items.find((item: any) => item.id === "steeringMode")).toBeTruthy();
		await expect(fx.post("/api/settings", { id: "nope", value: 1 })).rejects.toThrow(/Unknown setting/);
		// Every setting the UI lists must accept its own current value.
		for (const item of settings.items) {
			await fx.post("/api/settings", { id: item.id, value: item.value });
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

	it("adds a custom provider with detected models, keeps its key in the credential store and deletes both for good", async () => {
		const fx = await start();
		const catalog = createServer((req, res) => {
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

		const detected = await fx.post("/api/providers/custom/detect", {
			baseUrl,
			api: "openai-completions",
			apiKey: "sk-form-key",
		});
		expect(detected.ok).toBe(true);
		expect(detected.models).toEqual([
			{ id: "plain", name: "plain" },
			{ id: "thinker", name: "thinker", reasoning: true, input: ["text", "image"], contextWindow: 32000 },
		]);
		// A failed lookup is reported, not thrown, so the form can fall back to manual entry.
		const unreachable = await fx.post("/api/providers/custom/detect", {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
		});
		expect(unreachable.ok).toBe(false);

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

	it("runs direct shell commands and streams their output", async () => {
		const fx = await start();
		const started = await fx.post("/api/bash", { command: "echo web-ui-shell", excludeFromContext: false });
		const end = await fx.waitFor("bash_end", (data) => data.id === started.id);
		expect(end.output).toContain("web-ui-shell");
		expect(end.exitCode).toBe(0);
	});
});
