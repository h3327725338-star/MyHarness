import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@myharness/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { registerModeRoutes } from "../src/modes/web/routes-modes.ts";
import { registerProviderRoutes } from "../src/modes/web/routes-providers.ts";
import { registerSessionRoutes } from "../src/modes/web/routes-sessions.ts";
import { registerSettingsRoutes } from "../src/modes/web/routes-settings.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";

// A task that ends may show the system popup; this test only needs it not to appear on the desktop.
vi.mock("../src/utils/popup-notification.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/popup-notification.ts")>();
	return { ...actual, showPopupNotification: vi.fn(() => true) };
});

interface Fixture {
	project: string;
	events: Array<{ event: string; data: any }>;
	faux: ReturnType<typeof registerFauxProvider>;
	get(path: string): Promise<any>;
	post(path: string, body?: unknown): Promise<any>;
	waitFor(event: string, predicate?: (data: any) => boolean, timeoutMs?: number): Promise<any>;
}

describe("apply_patch in the Web change panel", () => {
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

	// The same Web runtime as web-host.test.ts, with the tool allowlist naming apply_patch (it is optional and off by default).
	async function start(): Promise<Fixture> {
		const project = tempDir("myharness-apply-patch-project");
		const dataRoot = tempDir("myharness-apply-patch-data");
		const agentDir = tempDir("myharness-apply-patch-agent");
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
					tools: ["read", "apply_patch"],
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
		registerModeRoutes(server, host, hub);
		registerFileRoutes(server, host);
		registerGitRoutes(server, host);
		registerSettingsRoutes(server, host);
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

		const call = async (method: string, path: string, body?: unknown) => {
			const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
				method,
				headers: { "x-myharness-web": "1", "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const json = (await response.json()) as any;
			if (!response.ok) throw new Error(`${response.status}: ${json.error}`);
			return json;
		};
		return {
			project,
			events,
			faux,
			get: (path) => call("GET", path),
			post: (path, body) => call("POST", path, body ?? {}),
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

	it("lists the files one apply_patch updated, added and deleted in the change panel, each with its diff", async () => {
		const fx = await start();
		writeFileSync(join(fx.project, "notes.txt"), "alpha\n");
		writeFileSync(join(fx.project, "gone.txt"), "bye\n");
		const patch = [
			"*** Begin Patch",
			"*** Update File: notes.txt",
			"@@",
			" alpha",
			"+beta",
			"*** Add File: added.txt",
			"+fresh",
			"*** Delete File: gone.txt",
			"*** End Patch",
		].join("\n");
		fx.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read", { path: "gone.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("apply_patch", { patch })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("All done.")]),
		]);
		await fx.post("/api/prompt", { text: "patch the notes" });
		const finished = await fx.waitFor("run_finished");
		expect(finished.outcome).toBe("completed");
		expect(finished.changeCount).toBe(3);
		expect(readFileSync(join(fx.project, "notes.txt"), "utf8")).toBe("alpha\nbeta\n");
		expect(readFileSync(join(fx.project, "added.txt"), "utf8")).toBe("fresh\n");
		expect(existsSync(join(fx.project, "gone.txt"))).toBe(false);

		const changes = await fx.get("/api/changes?scope=run");
		expect(changes.files.map((file: any) => [file.path, file.status]).sort()).toEqual([
			["added.txt", "added"],
			["gone.txt", "deleted"],
			["notes.txt", "modified"],
		]);
		const notes = await fx.get("/api/changes/diff?scope=run&path=notes.txt");
		expect(notes.patch).toContain("+beta");
		const added = await fx.get("/api/changes/diff?scope=run&path=added.txt");
		expect(added.patch).toContain("+fresh");
		const gone = await fx.get("/api/changes/diff?scope=run&path=gone.txt");
		expect(gone.patch).toContain("-bye");
	});

	it("records a patch path written with a leading @ under the file the tool actually changed", async () => {
		const fx = await start();
		writeFileSync(join(fx.project, "notes.txt"), "alpha\n");
		const patch = ["*** Begin Patch", "*** Update File: @notes.txt", "@@", " alpha", "+beta", "*** End Patch"].join(
			"\n",
		);
		fx.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("apply_patch", { patch })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("All done.")]),
		]);
		await fx.post("/api/prompt", { text: "patch with an @ path" });
		const finished = await fx.waitFor("run_finished");
		expect(finished.changeCount).toBe(1);
		expect(readFileSync(join(fx.project, "notes.txt"), "utf8")).toBe("alpha\nbeta\n");

		const changes = await fx.get("/api/changes?scope=run");
		expect(changes.files).toEqual([expect.objectContaining({ path: "notes.txt", status: "modified" })]);
		const notes = await fx.get("/api/changes/diff?scope=run&path=notes.txt");
		expect(notes.patch).toContain("+beta");
	});

	it("leaves the change panel alone for an apply_patch call whose patch does not parse", async () => {
		const fx = await start();
		writeFileSync(join(fx.project, "notes.txt"), "alpha\n");
		fx.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_patch", { patch: "not a patch" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The patch was rejected.")]),
		]);
		await fx.post("/api/prompt", { text: "patch badly" });
		const finished = await fx.waitFor("run_finished");

		expect(finished.outcome).toBe("completed");
		expect(finished.changeCount).toBe(0);
		expect(readFileSync(join(fx.project, "notes.txt"), "utf8")).toBe("alpha\n");
		expect(fx.events).toContainEqual(
			expect.objectContaining({
				event: "tool_end",
				data: expect.objectContaining({ toolName: "apply_patch", isError: true }),
			}),
		);
	});

	it("lists both ends of a moved file in the change panel, source deleted and target added", async () => {
		const fx = await start();
		writeFileSync(join(fx.project, "old.txt"), "alpha\n");
		const patch = [
			"*** Begin Patch",
			"*** Update File: old.txt",
			"*** Move to: new.txt",
			"@@",
			" alpha",
			"+beta",
			"*** End Patch",
		].join("\n");
		fx.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "old.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("apply_patch", { patch })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("All done.")]),
		]);
		await fx.post("/api/prompt", { text: "move the notes and patch them" });
		const finished = await fx.waitFor("run_finished");
		expect(finished.outcome).toBe("completed");
		expect(existsSync(join(fx.project, "old.txt"))).toBe(false);
		expect(readFileSync(join(fx.project, "new.txt"), "utf8")).toBe("alpha\nbeta\n");

		const changes = await fx.get("/api/changes?scope=run");
		expect(changes.files.map((file: any) => [file.path, file.status]).sort()).toEqual([
			["new.txt", "added"],
			["old.txt", "deleted"],
		]);
		const source = await fx.get("/api/changes/diff?scope=run&path=old.txt");
		expect(source.patch).toContain("-alpha");
		const target = await fx.get("/api/changes/diff?scope=run&path=new.txt");
		expect(target.patch).toContain("+alpha");
		expect(target.patch).toContain("+beta");
	});
});
