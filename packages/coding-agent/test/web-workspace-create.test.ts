import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerFauxProvider } from "@myharness/ai/compat";
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
		const project = tempDir("ws-create-project");
		const dataRoot = tempDir("ws-create-data");
		const agentDir = tempDir("ws-create-agent");
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
		await hub.addPrimary(runtimeHost, new WebDialogBridge());
		const address = await server.listen(0);
		cleanups.push(() => server.close());

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
			get: (path: string) => call("GET", path),
			post: (path: string, body?: unknown) => call("POST", path, body),
		};
	}

	async function resetGeneral(fx: {
		get: (path: string) => Promise<any>;
		post: (path: string, body?: unknown) => Promise<any>;
	}) {
		const { workspaces } = await fx.get("/api/workspaces?mode=general");
		for (const workspace of workspaces) {
			await fx.post("/api/workspaces/remove", { id: workspace.id, mode: "general" });
		}
	}

	it("creates a real sub-folder under the reference workspace parent and registers it (general only)", async () => {
		const fx = await start();
		await resetGeneral(fx);
		// No general workspace yet: no base to build on.
		await expect(fx.get("/api/workspaces/create-target?mode=general")).rejects.toMatchObject({ status: 404 });

		// Seed one general workspace inside its own parent dir.
		const parent = tempDir("ws-create-parent");
		const seed = join(parent, "seed-project");
		mkdirSync(seed, { recursive: true });
		await fx.post("/api/workspaces/add", { path: seed, mode: "general" });

		const target = await fx.get("/api/workspaces/create-target?mode=general");
		expect(target.baseDir).toBe(dirname(seed));

		const created = await fx.post("/api/workspaces/create", { name: "my-new-space", mode: "general" });
		expect(created.workspace.rootPath).toBe(join(parent, "my-new-space"));
		expect(existsSync(join(parent, "my-new-space"))).toBe(true);

		const list = await fx.get("/api/workspaces?mode=general");
		expect(list.workspaces.map((w: any) => w.rootPath)).toContain(join(parent, "my-new-space"));

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
		expect(existsSync(join(parent, "dupe"))).toBe(true);
		await expect(fx.post("/api/workspaces/create", { name: "dupe", mode: "general" })).rejects.toMatchObject({
			status: 409,
		});
		await expect(fx.post("/api/workspaces/create", { name: "  dupe  ", mode: "general" })).rejects.toMatchObject({
			status: 409,
		});
		await resetGeneral(fx);
	});
});
