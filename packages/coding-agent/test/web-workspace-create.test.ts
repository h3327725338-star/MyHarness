import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText } from "@myharness/ai/compat";
import { registerCoreRoutes } from "../src/modes/web/routes-core.ts";
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
import { registerSessionRoutes } from "../src/modes/web/routes-sessions.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";

describe("General quick-create workspace (real folders, isolated temp dirs)", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	const previousCwd = process.cwd();
	let previousAgentDir: string | undefined;
	const previousDataRoot = process.env.MYHARNESS_DATA_ROOT;

	afterEach(async () => {
		process.chdir(previousCwd);
		while (cleanups.length > 0) await cleanups.pop()?.();
		if (previousAgentDir === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = previousAgentDir;
		if (previousDataRoot === undefined) delete process.env.MYHARNESS_DATA_ROOT;
		else process.env.MYHARNESS_DATA_ROOT = previousDataRoot;
	});

	function tempDir(prefix: string): string {
		const dir = join(
			process.env.MYHARNESS_TEMP_DIR ?? tmpdir(),
			`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => {
			process.chdir(previousCwd);
			// Session runtimes may leave terminal handles alive briefly on Windows. Keep task-owned
			// artifact fixtures for inspection; only disposable OS-temp fixtures are removed here.
			if (!process.env.MYHARNESS_TEMP_DIR && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
		return dir;
	}

	async function start() {
		const project = tempDir("ws-create-project");
		const dataRoot = tempDir("ws-create-data");
		const agentDir = tempDir("ws-create-agent");
		process.env.MYHARNESS_DATA_ROOT = join(dataRoot, "data");
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
		const hub = new WebHostHub({ server, version: "test", onShutdown: () => {} });
		registerSessionRoutes(server, hub.host, hub);
		registerCoreRoutes(server, hub.host);
		await hub.addPrimary(runtimeHost, new WebDialogBridge());
		const address = await server.listen(0);
		cleanups.push(async () => {
			await hub.dispose();
			await server.close();
		});

		const call = async (method: string, path: string, body?: unknown) => {
			const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
				method,
				headers: { "x-myharness-web": "1", "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const json = (await response.json()) as any;
			if (!response.ok) {
				const error = new Error(`${response.status}: ${json.error}`) as Error & { status: number };
				error.status = response.status;
				throw error;
			}
			return json;
		};
		return {
			hub,
			faux,
			get: (path: string) => call("GET", path),
			post: (path: string, body?: unknown) => call("POST", path, body),
		};
	}

	it("re-reads instructions and sources on the next turn and correlates user events without persisting ids", async () => {
		const fx = await start();
		const created = await fx.post("/api/workspaces/create", { name: "live-context", mode: "general" });
		const id = created.workspace.id;
		const opened = await fx.post("/api/sessions/new", { rootPath: created.workspace.rootPath, mode: "general" });
		const events: any[] = [];
		const owner = fx.hub.get(opened.slot)!;
		owner.session.subscribe((event) => events.push(event));
		const settings = {
			id,
			name: "Live context",
			instructions: "UNIQUE_WORKSPACE_FIRST",
			memoryEnabled: true,
			libraryEnabled: true,
		};
		await fx.post("/api/workspaces/settings", settings);
		const source = await fx.post("/api/workspaces/sources/upload", {
			id,
			name: "shared.txt",
			data: Buffer.from("shared content").toString("base64"),
		});
		fx.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		await owner.submit("hello", { clientMessageId: "test-first" });
		await owner.session.waitForForegroundIdle();
		expect(owner.session.agent.state.systemPrompt).toContain("UNIQUE_WORKSPACE_FIRST");
		expect(owner.session.agent.state.systemPrompt).toContain(JSON.stringify(source.path));
		expect(owner.session.agent.state.systemPrompt).toContain(
			"They apply together with <user_personalization>, and they take precedence over it",
		);
		const user = events.find((event) => event.type === "message_start" && event.message.role === "user");
		expect(user).toBeDefined();
		const { promptCorrelation } = await import("../src/agent/runtime/prompt-correlation.ts");
		expect(promptCorrelation(user.message)).toBe("test-first");
		expect(JSON.stringify(owner.session.sessionManager.getBranch())).not.toContain("test-first");
		await fx.post("/api/workspaces/settings", {
			...settings,
			instructions: "UNIQUE_WORKSPACE_SECOND",
			libraryEnabled: false,
		});
		fx.faux.setResponses([fauxAssistantMessage([fauxText("done again")])]);
		await owner.submit("next");
		await owner.session.waitForForegroundIdle();
		expect(owner.session.agent.state.systemPrompt).toContain("UNIQUE_WORKSPACE_SECOND");
		expect(owner.session.agent.state.systemPrompt).not.toContain("UNIQUE_WORKSPACE_FIRST");
		expect(owner.session.agent.state.systemPrompt).not.toContain(JSON.stringify(source.path));
	});

	it("deletes one workspace source by id with clear 4xx answers and drops it from the next turn", async () => {
		const fx = await start();
		const created = await fx.post("/api/workspaces/create", { name: "source-delete", mode: "general" });
		const id = created.workspace.id;
		const upload = (name: string) =>
			fx.post("/api/workspaces/sources/upload", { id, name, data: Buffer.from(name).toString("base64") });
		const kept = await upload("kept.txt");
		const gone = await upload("gone.txt");
		expect(await fx.post("/api/workspaces/sources/delete", { id, sourceId: gone.id })).toEqual({ ok: true });
		const { sources } = await fx.get(`/api/workspaces/settings?id=${encodeURIComponent(id)}`);
		expect(sources.map((source: { id: string }) => source.id)).toEqual([kept.id]);
		await expect(fx.post("/api/workspaces/sources/delete", { id, sourceId: gone.id })).rejects.toMatchObject({
			status: 404,
		});
		await expect(fx.post("/api/workspaces/sources/delete", { id, sourceId: "../uploads" })).rejects.toMatchObject({
			status: 400,
		});
		await expect(
			fx.post("/api/workspaces/sources/delete", { id: "missing", sourceId: kept.id }),
		).rejects.toMatchObject({ status: 404 });
		const opened = await fx.post("/api/sessions/new", { rootPath: created.workspace.rootPath, mode: "general" });
		const owner = fx.hub.get(opened.slot)!;
		fx.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		await owner.submit("hello");
		await owner.session.waitForForegroundIdle();
		expect(owner.session.agent.state.systemPrompt).toContain(JSON.stringify(kept.path));
		expect(owner.session.agent.state.systemPrompt).not.toContain(JSON.stringify(gone.path));
	});

	it("uploads a folder source in chunks over HTTP and lists it as one line with its file count", async (ctx) => {
		const fx = await start();
		// Stored paths are kept under 250 characters; a fixture data root this long leaves no room for any file.
		if (process.env.MYHARNESS_DATA_ROOT!.length > 110) ctx.skip();
		const created = await fx.post("/api/workspaces/create", { name: "folder-sources", mode: "general" });
		const id = created.workspace.id;
		const refused = await fx.post("/api/workspaces/sources/stage", {
			id,
			items: [{ kind: "folder", name: "Docs", files: [{ path: "big/disk.img", size: 500 * 1024 * 1024 + 1 }] }],
		});
		expect(refused).toEqual({ problems: [{ item: 0, path: "big/disk.img", reason: "too_large" }] });
		const files = ["one.txt", "sub/two.txt", "sub/deeper/three.txt"];
		const staged = await fx.post("/api/workspaces/sources/stage", {
			id,
			items: [{ kind: "folder", name: "Docs", files: files.map((path) => ({ path, size: path.length })) }],
		});
		expect(staged.problems).toBeUndefined();
		const { sourceId } = staged.uploads[0];
		for (const [index, path] of files.entries())
			expect(
				await fx.post("/api/workspaces/sources/chunk", {
					id,
					sourceId,
					index,
					offset: 0,
					data: Buffer.from(path).toString("base64"),
				}),
			).toEqual({ done: true });
		const folder = await fx.post("/api/workspaces/sources/finish", { id, sourceId });
		expect(folder).toMatchObject({ id: sourceId, kind: "folder", fileCount: 3 });
		await expect(fx.post("/api/workspaces/sources/finish", { id, sourceId })).rejects.toMatchObject({ status: 404 });
		const tree = await fx.get(
			`/api/workspaces/sources/tree?id=${encodeURIComponent(id)}&sourceId=${encodeURIComponent(sourceId)}`,
		);
		expect(tree.entries.map((entry: { name: string }) => entry.name).sort()).toEqual(["one.txt", "sub"]);
		expect(await fx.post("/api/workspaces/sources/delete", { id, sourceId, path: "sub/two.txt" })).toEqual({
			ok: true,
		});
		const opened = await fx.post("/api/sessions/new", { rootPath: created.workspace.rootPath, mode: "general" });
		const owner = fx.hub.get(opened.slot)!;
		fx.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		await owner.submit("hello");
		await owner.session.waitForForegroundIdle();
		const line = JSON.stringify({ name: "Docs", path: folder.path, type: "folder", files: 2 });
		expect(owner.session.agent.state.systemPrompt).toContain(line);
		expect(owner.session.agent.state.systemPrompt).not.toContain("one.txt");
	});

	async function resetGeneral(fx: {
		get: (path: string) => Promise<any>;
		post: (path: string, body?: unknown) => Promise<any>;
	}) {
		const { workspaces } = await fx.get("/api/workspaces?mode=general");
		for (const workspace of workspaces) {
			await fx.post("/api/workspaces/remove", { id: workspace.id, mode: "general" });
		}
	}

	it("uses the registry data root regardless of existing workspaces or cwd (general only)", async () => {
		const fx = await start();
		await resetGeneral(fx);
		// No general workspace yet: the same internal data-root location is still available.
		const fallbackTarget = await fx.get("/api/workspaces/create-target?mode=general");
		expect(typeof fallbackTarget.baseDir).toBe("string");
		expect(fallbackTarget.baseDir).toBe(join(process.cwd(), "data", "workspace-folders"));
		expect(fallbackTarget.referenceName).toBe("");
		expect(fallbackTarget.referencePath).toBe("");

		// Seed one general workspace inside its own parent dir.
		const parent = tempDir("ws-create-parent");
		const seed = join(parent, "seed-project");
		mkdirSync(seed, { recursive: true });
		await fx.post("/api/workspaces/add", { path: seed, mode: "general" });

		const target = await fx.get("/api/workspaces/create-target?mode=general");
		expect(target.baseDir).toBe(fallbackTarget.baseDir);
		process.chdir(parent);
		expect((await fx.get("/api/workspaces/create-target?mode=general")).baseDir).toBe(target.baseDir);

		const created = await fx.post("/api/workspaces/create", { name: "my-new-space", mode: "general" });
		expect(created.workspace.rootPath).toBe(join(target.baseDir, "my-new-space"));
		expect(existsSync(join(target.baseDir, "my-new-space"))).toBe(true);

		const list = await fx.get("/api/workspaces?mode=general");
		expect(list.workspaces.map((w: any) => w.rootPath)).toContain(join(target.baseDir, "my-new-space"));

		// Coding mode is isolated: quick-create is rejected there.
		await expect(fx.post("/api/workspaces/create", { name: "coding-try", mode: "coding" })).rejects.toMatchObject({
			status: 400,
		});
		expect(existsSync(join(parent, "coding-try"))).toBe(false);
		await resetGeneral(fx);
	});

	it("rejects blank, illegal and duplicate names without touching disk", async () => {
		const fx = await start();
		await resetGeneral(fx);
		const parent = tempDir("ws-create-parent2");
		const seed = join(parent, "seed");
		mkdirSync(seed, { recursive: true });
		await fx.post("/api/workspaces/add", { path: seed, mode: "general" });

		for (const bad of ["", "   ", "a/b", "a\\b", "a:b", "a*b", 'a"b', "a<b", "a>b", "a|b", ".", "..", "trail."]) {
			await expect(fx.post("/api/workspaces/create", { name: bad, mode: "general" })).rejects.toMatchObject({
				status: 400,
			});
		}
		expect(existsSync(join(parent, "a"))).toBe(false);

		// Duplicate: first create succeeds, second returns 409 and keeps the original folder.
		await fx.post("/api/workspaces/create", { name: "dupe", mode: "general" });
		const { baseDir } = await fx.get("/api/workspaces/create-target?mode=general");
		expect(existsSync(join(baseDir, "dupe"))).toBe(true);
		mkdirSync(join(baseDir, "existing"));
		const adopted = await fx.post("/api/workspaces/create", { name: "existing", mode: "general" });
		expect(adopted.workspace.rootPath).toBe(join(baseDir, "existing"));
		await expect(fx.post("/api/workspaces/create", { name: "dupe", mode: "general" })).rejects.toMatchObject({
			status: 409,
		});
		await expect(fx.post("/api/workspaces/create", { name: "  dupe  ", mode: "general" })).rejects.toMatchObject({
			status: 409,
		});
		await resetGeneral(fx);
	});
});
