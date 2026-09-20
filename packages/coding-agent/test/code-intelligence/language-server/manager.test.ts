import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { LspClient, type LspInitializeOptions } from "../../../src/symbols/lsp/client.ts";
import {
	InvalidWorkspaceRootError,
	LanguageServerInitializeError,
	LanguageServerInstanceDisposedError,
	LanguageServerManagerDisposedError,
	LanguageServerUnavailableError,
	NoLanguageServerRegisteredError,
	UnsupportedLanguageError,
} from "../../../src/symbols/lsp/language-server/errors.ts";
import type {
	LanguageServerClientFactory,
	LanguageServerDefinition,
	LanguageServerDefinitionInput,
} from "../../../src/symbols/lsp/language-server/index.ts";
import { LanguageServerManager } from "../../../src/symbols/lsp/language-server/manager.ts";
import { LanguageServerRegistry } from "../../../src/symbols/lsp/language-server/registry.ts";
import type { LspLogger } from "../../../src/symbols/lsp/types.ts";

const FIXTURE = fileURLToPath(new URL("../lsp/fixtures/mock-lsp-server.mjs", import.meta.url));

const managers = new Set<LanguageServerManager>();
const temporaryRoots = new Set<string>();

afterEach(async () => {
	for (const manager of managers) {
		try {
			await manager.dispose();
		} catch {
			// Cleanup must continue so one failed disposal cannot leak later tests.
		}
	}
	managers.clear();
	for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
	temporaryRoots.clear();
});

function createDefinition(
	id: string,
	scenario = "standard",
	languages: readonly string[] = ["typescript", "javascript"],
	priority = 0,
	command = process.execPath,
): LanguageServerDefinitionInput {
	return {
		id,
		languages,
		command,
		args: [FIXTURE, scenario],
		priority,
		clientInfo: { name: "myharness-phase4-test", version: "1.0.0" },
	};
}

async function createWorkspace(name?: string): Promise<string> {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "myharness-language-server-manager-"));
	temporaryRoots.add(temporaryRoot);
	if (!name) return temporaryRoot;
	const workspaceRoot = join(temporaryRoot, name);
	await mkdir(workspaceRoot);
	return workspaceRoot;
}

function createRealClient(
	definition: LanguageServerDefinition,
	workspaceRoot: string,
	logger: LspLogger | undefined,
): LspClient {
	return new LspClient(
		{
			command: definition.command,
			args: definition.args,
			cwd: workspaceRoot,
			env: { ...process.env, ...(definition.env ?? {}) },
			logger,
		},
		{ ...(definition.clientOptions ?? {}), logger },
	);
}

function createManager(
	definitions: readonly LanguageServerDefinitionInput[],
	createClient?: LanguageServerClientFactory,
): LanguageServerManager {
	const registry = new LanguageServerRegistry();
	for (const definition of definitions) registry.register(definition);
	const manager = new LanguageServerManager({
		registry,
		...(createClient ? { createClient } : {}),
	});
	managers.add(manager);
	return manager;
}

function createCountingFactory(created: LspClient[]): LanguageServerClientFactory {
	return (definition, workspaceRoot, logger) => {
		const client = createRealClient(definition, workspaceRoot, logger);
		created.push(client);
		return client;
	};
}

class DelayedInitializeClient extends LspClient {
	private readonly gate: Promise<void>;
	private readonly onInitializeStarted: () => void;

	constructor(
		processOptions: ConstructorParameters<typeof LspClient>[0],
		clientOptions: ConstructorParameters<typeof LspClient>[1],
		gate: Promise<void>,
		onInitializeStarted: () => void,
	) {
		super(processOptions, clientOptions);
		this.gate = gate;
		this.onInitializeStarted = onInitializeStarted;
	}

	override async initialize(options: LspInitializeOptions = {}) {
		this.onInitializeStarted();
		await this.gate;
		return super.initialize(options);
	}
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise<void>((resolve, reject) => {
		const check = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error("timed out waiting for language-server state"));
				return;
			}
			setTimeout(check, 10);
		};
		check();
	});
}

describe("LanguageServerManager: startup and routing", () => {
	it("starts and initializes a real Phase 3 client", async () => {
		const workspaceRoot = await createWorkspace();
		const manager = createManager([createDefinition("typescript-server")]);

		const managed = await manager.acquire({ workspaceRoot, language: "TypeScript" });

		expect(managed.client.state).toBe("initialized");
		expect(managed.state).toBe("ready");
		expect(managed.workspaceRoot).toBe(workspaceRoot);
		expect(manager.getServers()).toMatchObject([
			{ definitionId: "typescript-server", workspaceRoot, state: "ready", clientState: "initialized" },
		]);
	});

	it("reuses one instance for multiple files and supported languages", async () => {
		const workspaceRoot = await createWorkspace();
		const manager = createManager([createDefinition("web-server")]);

		const typescript = await manager.getClientForFile("src/index.ts", { workspaceRoot });
		const javascript = await manager.getClientForFile("src/index.js", { workspaceRoot });

		expect(javascript).toBe(typescript);
		expect(manager.getServers()).toHaveLength(1);
	});

	it("reuses one instance for equivalent Windows workspace path forms", async () => {
		const workspaceRoot = await createWorkspace();
		const alias = workspaceRoot.replace(/\\/g, "/").toUpperCase();
		const manager = createManager([createDefinition("web-server")]);

		const first = await manager.acquire({ workspaceRoot, language: "typescript" });
		const second = await manager.acquire({ workspaceRoot: alias, language: "typescript" });

		expect(second.client).toBe(first.client);
		expect(manager.getServers()).toHaveLength(1);
	});

	it("isolates the same definition across workspaces", async () => {
		const firstRoot = await createWorkspace();
		const secondRoot = await createWorkspace();
		const created: LspClient[] = [];
		const manager = createManager([createDefinition("web-server")], createCountingFactory(created));

		const first = await manager.acquire({ workspaceRoot: firstRoot, language: "typescript" });
		const second = await manager.acquire({ workspaceRoot: secondRoot, language: "typescript" });

		expect(second.client).not.toBe(first.client);
		expect(created).toHaveLength(2);
		expect(manager.getServers()).toHaveLength(2);
	});

	it("isolates different definitions in one workspace", async () => {
		const workspaceRoot = await createWorkspace();
		const manager = createManager([
			createDefinition("server-a", "standard", ["typescript"], 10),
			createDefinition("server-b", "standard", ["typescript"], 0),
		]);

		const first = await manager.acquire({ workspaceRoot, language: "typescript", definitionId: "server-a" });
		const second = await manager.acquire({ workspaceRoot, language: "typescript", definitionId: "server-b" });

		expect(second.client).not.toBe(first.client);
		expect(manager.getServers().map((entry) => entry.definitionId)).toEqual(["server-a", "server-b"]);
	});

	it("shares one startup promise for 50 concurrent acquires", async () => {
		const workspaceRoot = await createWorkspace();
		const created: LspClient[] = [];
		let releaseInitialize!: () => void;
		let notifyInitializeStarted!: () => void;
		const initializeStarted = new Promise<void>((resolve) => {
			notifyInitializeStarted = resolve;
		});
		const initializeGate = new Promise<void>((resolve) => {
			releaseInitialize = resolve;
		});
		const createClient: LanguageServerClientFactory = (definition, root, logger) => {
			const client = new DelayedInitializeClient(
				{
					command: definition.command,
					args: definition.args,
					cwd: root,
					env: { ...process.env, ...(definition.env ?? {}) },
					logger,
				},
				{ ...(definition.clientOptions ?? {}), logger },
				initializeGate,
				notifyInitializeStarted,
			);
			created.push(client);
			return client;
		};
		const manager = createManager([createDefinition("web-server")], createClient);

		const acquisitions = Array.from({ length: 50 }, () => manager.acquire({ workspaceRoot, language: "typescript" }));
		await initializeStarted;
		expect(created).toHaveLength(1);
		expect(manager.getServers()[0]?.state).toBe("starting");
		releaseInitialize();

		const managed = await Promise.all(acquisitions);
		expect(new Set(managed.map((entry) => entry.client)).size).toBe(1);
		expect(created).toHaveLength(1);
		expect(manager.getServers()).toHaveLength(1);
	});
});

describe("LanguageServerManager: failures and fallback", () => {
	it("reports an unavailable command and cleans up the failed client", async () => {
		const workspaceRoot = await createWorkspace();
		const created: LspClient[] = [];
		const manager = createManager(
			[
				createDefinition(
					"missing-server",
					"standard",
					["typescript"],
					0,
					join(workspaceRoot, "missing-language-server"),
				),
			],
			createCountingFactory(created),
		);

		await expect(manager.acquire({ workspaceRoot, language: "typescript" })).rejects.toBeInstanceOf(
			LanguageServerUnavailableError,
		);
		expect(manager.getServers()).toHaveLength(0);
		expect(created[0]?.state).toBe("closed");
	});

	it("falls back only when the higher-priority command is unavailable", async () => {
		const workspaceRoot = await createWorkspace();
		const created: LspClient[] = [];
		const manager = createManager(
			[
				createDefinition(
					"missing-primary",
					"standard",
					["typescript"],
					100,
					join(workspaceRoot, "missing-primary"),
				),
				createDefinition("working-secondary", "standard", ["typescript"], 0),
			],
			createCountingFactory(created),
		);

		const managed = await manager.acquire({ workspaceRoot, language: "typescript" });

		expect(managed.definition.id).toBe("working-secondary");
		expect(created).toHaveLength(2);
		expect(created[0]?.state).toBe("closed");
	});

	it("does not fall back after initialize failure", async () => {
		const workspaceRoot = await createWorkspace();
		const created: LspClient[] = [];
		const manager = createManager(
			[
				createDefinition("init-failure", "init-error", ["typescript"], 100),
				createDefinition("should-not-start", "standard", ["typescript"], 0),
			],
			createCountingFactory(created),
		);

		await expect(manager.acquire({ workspaceRoot, language: "typescript" })).rejects.toBeInstanceOf(
			LanguageServerInitializeError,
		);
		expect(created).toHaveLength(1);
		expect(manager.getServers()).toHaveLength(0);
	});

	it("evicts a crashed client and lazily starts a replacement", async () => {
		const workspaceRoot = await createWorkspace();
		const created: LspClient[] = [];
		const manager = createManager([createDefinition("crashing-server", "crash")], createCountingFactory(created));

		const first = await manager.acquire({ workspaceRoot, language: "typescript" });
		await expect(first.client.request("crash/request", {})).rejects.toBeInstanceOf(Error);
		await waitFor(() => first.client.state === "failed");
		expect(manager.getServers()[0]?.state).toBe("failed");

		const second = await manager.acquire({ workspaceRoot, language: "typescript" });
		expect(second.client).not.toBe(first.client);
		expect(created).toHaveLength(2);
	});

	it("rejects unsupported files before spawning and validates workspace roots", async () => {
		const workspaceRoot = await createWorkspace();
		const created: LspClient[] = [];
		const manager = createManager([createDefinition("typescript-server")], createCountingFactory(created));

		await expect(manager.getClientForFile("README.unknown", { workspaceRoot })).rejects.toBeInstanceOf(
			UnsupportedLanguageError,
		);
		await expect(
			manager.acquire({ workspaceRoot: join(workspaceRoot, "missing"), language: "typescript" }),
		).rejects.toBeInstanceOf(InvalidWorkspaceRootError);
		await expect(manager.acquire({ workspaceRoot, language: "python" })).rejects.toBeInstanceOf(
			NoLanguageServerRegisteredError,
		);
		expect(created).toHaveLength(0);
	});
});

describe("LanguageServerManager: disposal", () => {
	it("disposes one instance while leaving another workspace alive", async () => {
		const firstRoot = await createWorkspace();
		const secondRoot = await createWorkspace();
		const manager = createManager([createDefinition("web-server")]);
		const first = await manager.acquire({ workspaceRoot: firstRoot, language: "typescript" });
		const second = await manager.acquire({ workspaceRoot: secondRoot, language: "typescript" });

		await manager.disposeServer({ definitionId: "web-server", workspaceRoot: firstRoot });

		expect(first.client.state).toBe("closed");
		expect(second.client.state).toBe("initialized");
		expect(manager.getServers()).toHaveLength(1);
	});

	it("disposes a whole workspace and then all remaining instances", async () => {
		const firstRoot = await createWorkspace();
		const secondRoot = await createWorkspace();
		const manager = createManager([
			createDefinition("server-a", "standard", ["typescript"], 10),
			createDefinition("server-b", "standard", ["typescript"], 0),
		]);
		const first = await manager.acquire({
			workspaceRoot: firstRoot,
			language: "typescript",
			definitionId: "server-a",
		});
		const second = await manager.acquire({
			workspaceRoot: firstRoot,
			language: "typescript",
			definitionId: "server-b",
		});
		const third = await manager.acquire({
			workspaceRoot: secondRoot,
			language: "typescript",
			definitionId: "server-a",
		});

		await manager.disposeWorkspace(firstRoot);
		expect(first.client.state).toBe("closed");
		expect(second.client.state).toBe("closed");
		expect(third.client.state).toBe("initialized");
		expect(manager.getServers()).toHaveLength(1);

		await manager.dispose();
		expect(third.client.state).toBe("closed");
		expect(manager.getServers()).toHaveLength(0);
	});

	it("makes dispose idempotent and rejects acquires afterwards", async () => {
		const workspaceRoot = await createWorkspace();
		const manager = createManager([createDefinition("web-server")]);
		await manager.acquire({ workspaceRoot, language: "typescript" });

		await Promise.all([manager.dispose(), manager.dispose(), manager.dispose()]);
		await expect(manager.acquire({ workspaceRoot, language: "typescript" })).rejects.toBeInstanceOf(
			LanguageServerManagerDisposedError,
		);
	});

	it("closes the process when disposal races initialization", async () => {
		const workspaceRoot = await createWorkspace();
		const created: LspClient[] = [];
		let releaseInitialize!: () => void;
		let notifyInitializeStarted!: () => void;
		const initializeStarted = new Promise<void>((resolve) => {
			notifyInitializeStarted = resolve;
		});
		const initializeGate = new Promise<void>((resolve) => {
			releaseInitialize = resolve;
		});
		const createClient: LanguageServerClientFactory = (definition, root, logger) => {
			const client = new DelayedInitializeClient(
				{
					command: definition.command,
					args: definition.args,
					cwd: root,
					env: { ...process.env, ...(definition.env ?? {}) },
					logger,
				},
				{ ...(definition.clientOptions ?? {}), logger },
				initializeGate,
				notifyInitializeStarted,
			);
			created.push(client);
			return client;
		};
		const manager = createManager([createDefinition("web-server")], createClient);
		const acquiring = manager.acquire({ workspaceRoot, language: "typescript" });
		await initializeStarted;

		const disposing = manager.dispose();
		releaseInitialize();
		await expect(acquiring).rejects.toBeInstanceOf(LanguageServerInstanceDisposedError);
		await disposing;
		expect(created[0]?.state).toBe("closed");
		expect(manager.getServers()).toHaveLength(0);
	});

	it("normalizes workspace paths containing spaces and Unicode", async () => {
		const workspaceRoot = await createWorkspace("workspace with spaces 中文");
		const manager = createManager([createDefinition("web-server")]);

		const first = await manager.acquire({ workspaceRoot, language: "typescript" });
		const second = await manager.acquire({ workspaceRoot: `${workspaceRoot}${sep}`, language: "typescript" });

		expect(second.client).toBe(first.client);
		expect(basename(workspaceRoot)).toContain("中文");
		expect(manager.getServers()).toHaveLength(1);
	});

	it("returns immutable status snapshots", async () => {
		const workspaceRoot = await createWorkspace();
		const manager = createManager([createDefinition("web-server")]);
		await manager.acquire({ workspaceRoot, language: "typescript" });

		const snapshots = manager.getServers();
		expect(Object.isFrozen(snapshots)).toBe(true);
		expect(Object.isFrozen(snapshots[0])).toBe(true);
		expect(Object.isFrozen(snapshots[0]?.languages)).toBe(true);
	});
});
