import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@myharness/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Container, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/agent/runtime/session-runtime.ts";
import type { WorkspaceStore } from "../src/application/workspace-store.ts";
import {
	beginRepositoryDirectoryMove,
	initializeManagedLocalGitRepository,
	type LocalGitRepository,
	type LocalGitRepositoryStore,
} from "../src/git/local-repositories/store.ts";
import type { WorkspaceSidebarComponent } from "../src/modes/interactive/components/workspace-sidebar.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

type GitRelocationHost = {
	localGitRepositoryStore: LocalGitRepositoryStore;
	workspaceStore: WorkspaceStore;
	relocateLocalGitRepository(
		repository: LocalGitRepository,
		destinationRoot: string,
		operation: "renamed" | "moved",
	): Promise<{ ok: boolean; error?: string }>;
};

describe("AgentSessionRuntime.switchWorkspace", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let previousAgentDir: string | undefined;

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		if (previousAgentDir === undefined) {
			delete process.env.MYHARNESS_CODING_AGENT_DIR;
		} else {
			process.env.MYHARNESS_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	function createTempDir(prefix: string): string {
		const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
		return dir;
	}

	async function createRuntimeHost(initialCwd: string, sessionDir?: string, inMemory = false) {
		// Keep global configuration and the project-local Data root isolated per
		// runtime host so persisted Workspace/Session records cannot leak between
		// test files.
		const previousCwd = process.cwd();
		const dataRoot = createTempDir("myharness-ws-runtime-data");
		process.chdir(dataRoot);
		cleanups.push(() => process.chdir(previousCwd));
		const agentDir = createTempDir("myharness-ws-runtime-agent");
		previousAgentDir = process.env.MYHARNESS_CODING_AGENT_DIR;
		process.env.MYHARNESS_CODING_AGENT_DIR = agentDir;
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one")]);

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
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
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
			cwd: initialCwd,
			agentDir,
			sessionManager: inMemory ? SessionManager.inMemory(initialCwd) : SessionManager.create(initialCwd, sessionDir),
		});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
		});

		return runtimeHost;
	}

	it("deletes the current chat into an initialized blank session and reopens /workspace", async () => {
		initTheme("dark");
		const cwd = createTempDir("myharness-ws-delete-current");
		const runtimeHost = await createRuntimeHost(cwd);
		await runtimeHost.session.prompt("Existing chat");
		const otherFile = runtimeHost.session.sessionFile!;
		await runtimeHost.newSession();
		await runtimeHost.session.prompt("Delete this chat");
		const deletedSession = runtimeHost.session;
		const deletedFile = deletedSession.sessionFile!;
		expect(existsSync(deletedFile)).toBe(true);

		const mode = new InteractiveMode(runtimeHost);
		const host = mode as unknown as {
			ui: TUI;
			workspaceSidebar?: WorkspaceSidebarComponent;
			workspaceSidebarHandle?: unknown;
			editor: { getText(): string };
			editorContainer: Container;
			chatContainer: Container;
			showWorkspaceSidebar(): void;
		};
		const terminal = new VirtualTerminal(100, 30);
		const ui = host.ui;
		Object.assign(ui, { terminal });
		ui.addChild(host.chatContainer);
		ui.addChild(host.editorContainer);
		ui.setFocus(host.editorContainer.children[0]!);
		ui.start();
		cleanups.push(() => {
			mode.stop();
			ui.stop();
		});

		host.showWorkspaceSidebar();
		const sidebar = host.workspaceSidebar!;
		await vi.waitFor(() => expect(stripAnsi(sidebar.render(100).join("\n"))).toContain("Delete this chat"));
		// Move from the workspace to its most recent chat and confirm deletion.
		terminal.sendInput("\x1b[B");
		terminal.sendInput("d");
		expect(stripAnsi(sidebar.render(100).join("\n"))).toContain("Delete this chat?");
		terminal.sendInput("\r");
		await vi.waitFor(() => expect(existsSync(deletedFile)).toBe(false));
		expect(runtimeHost.session).not.toBe(deletedSession);
		expect(runtimeHost.session.sessionId).not.toBe(deletedSession.sessionId);
		expect(runtimeHost.session.sessionFile).not.toBe(otherFile);
		expect(runtimeHost.session.messages).toEqual([]);
		expect(runtimeHost.session.sessionManager.buildSessionContext().messages).toEqual([]);
		expect(runtimeHost.session.isIdle).toBe(true);
		expect(host.editor.getText()).toBe("");
		expect(host.workspaceSidebar).toBeUndefined();
		expect(host.workspaceSidebarHandle).toBeUndefined();
		expect(existsSync(otherFile)).toBe(true);

		host.showWorkspaceSidebar();
		expect(host.workspaceSidebar).toBeDefined();
		expect(host.workspaceSidebar).not.toBe(sidebar);
		await vi.waitFor(() => {
			const text = stripAnsi(host.workspaceSidebar!.render(100).join("\n"));
			expect(text).toContain("Existing chat");
			expect(text).not.toContain("Delete this chat");
		});
		await terminal.waitForRender();
		expect(stripAnsi((await terminal.flushAndGetViewport()).join("\n"))).toContain("Workspaces");
		terminal.sendInput("\x1b");
		expect(host.workspaceSidebar).toBeUndefined();
		// A prompt on the new runtime proves initialization and event rebinding completed.
		await runtimeHost.session.prompt("New chat works");
		expect(runtimeHost.session.messages.some((message) => message.role === "assistant")).toBe(true);
		expect(existsSync(deletedFile)).toBe(false);
	});

	it("rebuilds the runtime for the target cwd", async () => {
		const cwdA = createTempDir("myharness-ws-runtime-a");
		const cwdB = createTempDir("myharness-ws-runtime-b");
		const runtimeHost = await createRuntimeHost(cwdA);

		expect(runtimeHost.cwd).toBe(cwdA);
		const result = await runtimeHost.switchWorkspace(cwdB);
		expect(result.cancelled).toBe(false);

		// cwd and session are rebuilt for workspace B.
		expect(runtimeHost.cwd).toBe(cwdB);
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(cwdB);
		// A brand-new session id is generated (not resuming the old one).
		expect(runtimeHost.session.sessionId).not.toBe("");
		// The previous session file is not reused.
		expect(runtimeHost.session.sessionFile).not.toBe(undefined);
	});

	it("stores the new session in the default per-cwd session directory", async () => {
		const cwdA = createTempDir("myharness-ws-runtime-a");
		const cwdB = createTempDir("myharness-ws-runtime-b");
		const runtimeHost = await createRuntimeHost(cwdA);

		await runtimeHost.switchWorkspace(cwdB);
		const sessionFile = runtimeHost.session.sessionFile;
		expect(sessionFile).toBeDefined();
		// Session file lives in the project Data Framework tree and is a new
		// Workspace/Session scope for workspace B.
		expect(sessionFile!.includes("sessions")).toBe(true);
		expect(sessionFile!.endsWith(".jsonl")).toBe(true);
	});

	it("keeps a custom session directory across workspace switches", async () => {
		const cwdA = createTempDir("myharness-ws-runtime-a");
		const cwdB = createTempDir("myharness-ws-runtime-b");
		const customDir = createTempDir("myharness-ws-runtime-custom");
		const runtimeHost = await createRuntimeHost(cwdA, customDir);

		await runtimeHost.switchWorkspace(cwdB);
		expect(runtimeHost.session.sessionManager.getSessionDir()).toBe(customDir);
		expect(runtimeHost.cwd).toBe(cwdB);
	});

	it("keeps in-memory sessions in-memory when switching workspaces", async () => {
		const cwdA = createTempDir("myharness-ws-runtime-a");
		const cwdB = createTempDir("myharness-ws-runtime-b");
		const runtimeHost = await createRuntimeHost(cwdA, undefined, true);

		expect(runtimeHost.session.sessionManager.isPersisted()).toBe(false);
		await runtimeHost.switchWorkspace(cwdB);
		expect(runtimeHost.session.sessionManager.isPersisted()).toBe(false);
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(cwdB);
		expect(runtimeHost.cwd).toBe(cwdB);
	});

	it("relocates a persisted conversation to the new cwd", async () => {
		const cwdA = createTempDir("myharness-relocate-runtime-a");
		const cwdB = createTempDir("myharness-relocate-runtime-b");
		const runtimeHost = await createRuntimeHost(cwdA);
		await runtimeHost.session.prompt("Conversation to keep");
		const previousFile = runtimeHost.session.sessionFile!;
		const sessionId = runtimeHost.session.sessionId;

		const result = await runtimeHost.relocateWorkspace(cwdB);

		expect(result).toEqual({ cancelled: false, warnings: [] });
		expect(runtimeHost.cwd).toBe(cwdB);
		expect(runtimeHost.session.sessionId).toBe(sessionId);
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(cwdB);
		expect(runtimeHost.session.sessionManager.buildSessionContext().messages).toHaveLength(2);
		// Data Framework Session identity is independent from cwd. Relocation
		// updates the header in the same Workspace/Session data directory.
		expect(existsSync(previousFile)).toBe(true);
		const relocatedFile = runtimeHost.session.sessionFile!;
		expect(relocatedFile).toBe(previousFile);
		expect(existsSync(relocatedFile)).toBe(true);
		expect(SessionManager.open(relocatedFile).getHeader()?.cwd).toBe(cwdB);
	});

	it("restores the original cwd when relocation metadata preparation fails", async () => {
		const cwdA = createTempDir("myharness-relocate-runtime-a");
		const cwdB = createTempDir("myharness-relocate-runtime-b");
		const runtimeHost = await createRuntimeHost(cwdA);
		const originalSession = runtimeHost.session;

		await expect(
			runtimeHost.relocateWorkspace(cwdB, {
				beforeCommit: () => {
					throw new Error("metadata write failed");
				},
			}),
		).rejects.toThrow("metadata write failed");

		expect(runtimeHost.cwd).toBe(cwdA);
		expect(runtimeHost.session).not.toBe(originalSession);
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(cwdA);
		expect(runtimeHost.session.isIdle).toBe(true);
	});

	it("rolls back a deferred directory move when metadata preparation fails", async () => {
		const parent = createTempDir("myharness-relocate-runtime-move-parent");
		const source = join(parent, "source");
		const destination = join(parent, "destination");
		mkdirSync(source);
		const runtimeHost = await createRuntimeHost(source);
		let transaction: ReturnType<typeof beginRepositoryDirectoryMove> | undefined;

		await expect(
			runtimeHost.relocateWorkspace(destination, {
				moveDirectory: () => {
					transaction = beginRepositoryDirectoryMove(source, destination);
				},
				rollbackDirectoryMove: () => transaction?.rollback(),
				beforeCommit: () => {
					throw new Error("metadata write failed");
				},
			}),
		).rejects.toThrow("metadata write failed");

		expect(existsSync(source)).toBe(true);
		expect(existsSync(destination)).toBe(false);
		expect(runtimeHost.cwd).toBe(source);
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(source);
	});

	it.skipIf(!gitAvailable)("relocates an active repository and its Workspace record together", async () => {
		const parent = createTempDir("myharness-relocate-git-parent");
		const source = join(parent, "repository");
		const destination = join(parent, "renamed-repository");
		const sessionDir = join(source, ".sessions");
		mkdirSync(source);
		expect(initializeManagedLocalGitRepository(source).ok).toBe(true);
		const runtimeHost = await createRuntimeHost(source, sessionDir);
		await runtimeHost.session.prompt("Keep this chat while moving the repository");
		const previousSessionFile = runtimeHost.session.sessionFile!;
		const mode = new InteractiveMode(runtimeHost);
		cleanups.push(() => mode.stop());

		const host = mode as unknown as GitRelocationHost;
		const repository = host.localGitRepositoryStore.add(source).repository!;
		expect(host.workspaceStore.add(source).ok).toBe(true);

		const result = await host.relocateLocalGitRepository(repository, destination, "renamed");

		expect(result.ok, result.ok ? undefined : result.error).toBe(true);
		expect(existsSync(source)).toBe(false);
		expect(existsSync(destination)).toBe(true);
		expect(runtimeHost.cwd).toBe(destination);
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(destination);
		expect(runtimeHost.session.sessionManager.getSessionDir()).toBe(join(destination, ".sessions"));
		expect(existsSync(previousSessionFile)).toBe(false);
		expect(SessionManager.open(runtimeHost.session.sessionFile!).getHeader()?.cwd).toBe(destination);
		expect(host.localGitRepositoryStore.list()[0]?.rootPath).toBe(destination);
		expect(host.workspaceStore.getByRootPath(destination)?.rootPath).toBe(destination);
	});

	it.skipIf(!gitAvailable)("keeps an active session on its original path when rename validation fails", async () => {
		const parent = createTempDir("myharness-relocate-git-conflict-parent");
		const source = join(parent, "repository");
		const destination = join(parent, "occupied");
		mkdirSync(source);
		mkdirSync(destination);
		expect(initializeManagedLocalGitRepository(source).ok).toBe(true);
		const runtimeHost = await createRuntimeHost(source);
		const originalSession = runtimeHost.session;
		const mode = new InteractiveMode(runtimeHost);
		cleanups.push(() => mode.stop());
		const host = mode as unknown as GitRelocationHost;
		const repository = host.localGitRepositoryStore.add(source).repository!;
		expect(host.workspaceStore.getByRootPath(source)).toBeDefined();

		const result = await host.relocateLocalGitRepository(repository, destination, "renamed");

		expect(result.ok, result.error).toBe(false);
		expect(result.error).toContain("目标路径已存在");
		expect(existsSync(source)).toBe(true);
		expect(existsSync(destination)).toBe(true);
		expect(runtimeHost.session).toBe(originalSession);
		expect(runtimeHost.cwd).toBe(source);
		expect(host.localGitRepositoryStore.list()[0]?.rootPath).toBe(source);
		expect(host.workspaceStore.getByRootPath(source)?.rootPath).toBe(source);
	});

	it("rewrites a session file that moved with a custom session directory", () => {
		const agentDir = createTempDir("myharness-relocate-session-agent");
		const parent = createTempDir("myharness-relocate-session-parent");
		const sourceCwd = join(parent, "repository");
		const destinationCwd = join(parent, "renamed-repository");
		const sourceSessionDir = join(sourceCwd, ".sessions");
		mkdirSync(sourceCwd);
		const sourceManager = SessionManager.create(sourceCwd, sourceSessionDir);
		const sourceFile = sourceManager.getSessionFile()!;
		writeFileSync(sourceFile, `${JSON.stringify(sourceManager.getHeader())}\n`);
		const openedManager = SessionManager.open(sourceFile, sourceSessionDir);

		renameSync(sourceCwd, destinationCwd);
		const relocatedManager = openedManager.createRelocated(destinationCwd, agentDir);
		relocatedManager.commitRelocationFrom(openedManager);

		const relocatedSessionDir = join(destinationCwd, ".sessions");
		const relocatedFile = join(relocatedSessionDir, basename(sourceFile));
		expect(relocatedManager.getSessionDir()).toBe(relocatedSessionDir);
		expect(relocatedManager.getSessionFile()).toBe(relocatedFile);
		expect(existsSync(relocatedFile)).toBe(true);
		expect(SessionManager.open(relocatedFile, relocatedSessionDir).getHeader()?.cwd).toBe(destinationCwd);
	});

	it("throws when the target cwd does not exist", async () => {
		const cwdA = createTempDir("myharness-ws-runtime-a");
		const missing = join(cwdA, "missing-dir");
		const runtimeHost = await createRuntimeHost(cwdA);

		await expect(runtimeHost.switchWorkspace(missing)).rejects.toThrow("does not exist");
		// The original runtime is untouched after the failure.
		expect(runtimeHost.cwd).toBe(cwdA);
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(cwdA);
	});

	it("throws when the target is a file, not a directory", async () => {
		const cwdA = createTempDir("myharness-ws-runtime-a");
		const filePath = join(cwdA, "file.txt");
		writeFileSync(filePath, "x");
		const runtimeHost = await createRuntimeHost(cwdA);

		await expect(runtimeHost.switchWorkspace(filePath)).rejects.toThrow("is not a directory");
	});
});
