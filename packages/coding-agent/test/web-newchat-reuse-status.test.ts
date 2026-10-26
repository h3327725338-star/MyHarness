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
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { WebHostHub } from "../src/modes/web/hub.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";

// The browser keeps a blank chat on New chat without asking only when hub.newSession would answer with that chat
// (web/js/actions.js keepsNewChat). For a chat without a workspace it reads that from the slot status: these tests pin
// the status to what hub.newSession really does.
describe("slot status for New chat reuse", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let previousAgentDir: string | undefined;

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		if (previousAgentDir === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = previousAgentDir;
	});

	function tempDir(prefix: string): string {
		const dir = join(
			process.env.MYHARNESS_TEMP_DIR ?? tmpdir(),
			`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		});
		return dir;
	}

	/** A hub whose primary chat is a blank chat in a registered workspace folder. */
	async function start() {
		const project = tempDir("myharness-newchat-project");
		const agentDir = tempDir("myharness-newchat-agent");
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
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir,
				modelRuntime,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
				cwd,
			});
			services.settingsManager.setConversationNamingSettings({ enabled: false });
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: project,
			agentDir,
			sessionManager: SessionManager.create(project),
		});
		const server = new WebHttpServer();
		const hub = new WebHostHub({ server, version: "test", onShutdown: () => {} });
		const primary = await hub.addPrimary(runtimeHost, new WebDialogBridge());
		cleanups.push(async () => {
			await hub.dispose();
			await server.close();
			faux.unregister();
		});
		return { hub, primary, project, defaultDir: join(agentDir, "default-workspace") };
	}

	it("reports atDefaultDir for a blank unbound chat in the default directory, which hub.newSession reuses", async () => {
		const { hub, primary, defaultDir } = await start();
		expect(primary.status).toMatchObject({ unbound: false, atDefaultDir: false });

		const created = await hub.newSession(primary, undefined, true);
		expect(created.created).toBe(true);
		const unbound = hub.get(created.slot)!;
		expect(unbound.status).toMatchObject({ cwd: defaultDir, unbound: true, atDefaultDir: true });
		// New chat (unbound) and /new (no argument) from that chat are answered with the chat itself.
		expect(await hub.newSession(unbound, undefined, true)).toEqual({ slot: unbound.slotId, created: false });
		expect(await hub.newSession(unbound)).toEqual({ slot: unbound.slotId, created: false });
	});

	it("does not report atDefaultDir for a chat whose workspace was removed, which hub.newSession does not reuse", async () => {
		const { hub, primary, project } = await start();
		const workspace = primary.workspace;
		expect(workspace).toBeDefined();
		expect(primary.workspaceStore.remove(workspace!.workspaceId, "coding")).toBe(true);
		// Unbound now, but still running in the removed workspace's folder.
		expect(primary.status).toMatchObject({ cwd: project, unbound: true, atDefaultDir: false });
		// Both kinds of New chat go to the default directory, so the service answers with another chat.
		const fromNewChat = await hub.newSession(primary, undefined, true);
		expect(fromNewChat.slot).not.toBe(primary.slotId);
		expect(hub.get(fromNewChat.slot)!.status).toMatchObject({ unbound: true, atDefaultDir: true });
		expect((await hub.newSession(primary)).slot).not.toBe(primary.slotId);
	});
});
