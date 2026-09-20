import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { LspClient } from "../../../src/symbols/lsp/client.ts";
import {
	InvalidWorkspaceRootError,
	LanguageServerDisposalError,
	LanguageServerInitializeError,
	LanguageServerInstanceDisposedError,
	LanguageServerStartError,
	LanguageServerUnavailableError,
} from "../../../src/symbols/lsp/language-server/errors.ts";
import { LanguageServerManager } from "../../../src/symbols/lsp/language-server/manager.ts";
import {
	type LanguageServerDefinitionInput,
	LanguageServerRegistry,
} from "../../../src/symbols/lsp/language-server/registry.ts";
import type {
	LanguageServerClientFactory,
	LanguageServerDefinition,
} from "../../../src/symbols/lsp/language-server/types.ts";
import type { LspLogger } from "../../../src/symbols/lsp/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/acceptance-lsp-server.mjs", import.meta.url));

interface CreatedClient {
	readonly definitionId: string;
	readonly workspaceRoot: string;
	readonly client: LspClient;
	readonly initializeStarted: Promise<void>;
	initializeStarts: number;
}

const managers = new Set<LanguageServerManager>();
const temporaryRoots = new Set<string>();

afterEach(async () => {
	for (const manager of managers) {
		try {
			await manager.dispose();
		} catch {
			// Keep cleaning all managers and temporary roots after a failure.
		}
	}
	managers.clear();
	for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
	temporaryRoots.clear();
});

function definition(
	id: string,
	scenario = "standard",
	languages: readonly string[] = ["typescript"],
	priority = 0,
	command = process.execPath,
): LanguageServerDefinitionInput {
	return {
		id,
		languages,
		command,
		args: [FIXTURE, scenario],
		priority,
	};
}

async function workspace(name?: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "myharness-phase4-acceptance-"));
	temporaryRoots.add(root);
	if (!name) return root;
	const named = join(root, name);
	await mkdir(named);
	return named;
}

function createClient(
	serverDefinition: LanguageServerDefinition,
	workspaceRoot: string,
	logger: LspLogger | undefined,
): LspClient {
	return new LspClient(
		{
			command: serverDefinition.command,
			args: serverDefinition.args,
			cwd: workspaceRoot,
			env: { ...process.env, ...(serverDefinition.env ?? {}) },
			logger,
		},
		{ ...(serverDefinition.clientOptions ?? {}), logger },
	);
}

function trackedFactory(created: CreatedClient[]): LanguageServerClientFactory {
	return (serverDefinition, workspaceRoot, logger) => {
		const client = createClient(serverDefinition, workspaceRoot, logger);
		let resolveInitializeStarted!: () => void;
		const initializeStarted = new Promise<void>((resolve) => {
			resolveInitializeStarted = resolve;
		});
		const record: CreatedClient = {
			definitionId: serverDefinition.id,
			workspaceRoot,
			client,
			initializeStarted,
			initializeStarts: 0,
		};
		let offInitializeStarted: (() => void) | undefined;
		const handler = (): void => {
			record.initializeStarts += 1;
			resolveInitializeStarted();
			offInitializeStarted?.();
		};
		offInitializeStarted = client.onNotification("test/initialize-started", handler);
		created.push(record);
		return client;
	};
}

function managerFor(
	definitions: readonly LanguageServerDefinitionInput[],
	createClient?: LanguageServerClientFactory,
): LanguageServerManager {
	const registry = new LanguageServerRegistry();
	for (const serverDefinition of definitions) registry.register(serverDefinition);
	const manager = new LanguageServerManager({
		registry,
		...(createClient ? { createClient } : {}),
	});
	managers.add(manager);
	return manager;
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
				reject(new Error("timed out waiting for Phase 4 state"));
				return;
			}
			setTimeout(check, 10);
		};
		check();
	});
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function missingCommand(root: string, name: string): string {
	return join(root, `${name}-does-not-exist`);
}

class DisposeReportingFailureClient extends LspClient {
	override async dispose(): Promise<void> {
		await super.dispose();
		throw new Error("deliberate disposal failure after cleanup");
	}
}

describe("Phase 4 Final Acceptance: concurrency and lifecycle attacks", () => {
	it("100 same-key callers share one client, process, and initialize flow", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("delayed", "init-delay")], trackedFactory(created));

		const acquisitions = Array.from({ length: 100 }, () =>
			manager.acquire({ workspaceRoot: root, language: "typescript" }),
		);
		await created[0]?.initializeStarted;
		expect(created).toHaveLength(1);
		expect(created[0]?.initializeStarts).toBe(1);
		expect(manager.getServers()[0]?.state).toBe("starting");
		expect(created[0]?.client.processInfo.pid).toBeDefined();

		await created[0]?.client.notify("test/release-init");
		const managed = await Promise.all(acquisitions);
		expect(new Set(managed.map((entry) => entry.client)).size).toBe(1);
		expect(manager.getServers()).toHaveLength(1);
	});

	it("starts exactly one process per workspace under cross-workspace concurrency", async () => {
		const firstRoot = await workspace();
		const secondRoot = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("shared")], trackedFactory(created));

		const acquisitions = [
			...Array.from({ length: 50 }, () => manager.acquire({ workspaceRoot: firstRoot, language: "typescript" })),
			...Array.from({ length: 50 }, () => manager.acquire({ workspaceRoot: secondRoot, language: "typescript" })),
		];
		const managed = await Promise.all(acquisitions);

		expect(created).toHaveLength(2);
		expect(new Set(created.map((entry) => entry.client.processInfo.pid)).size).toBe(2);
		expect(new Set(managed.slice(0, 50).map((entry) => entry.client)).size).toBe(1);
		expect(new Set(managed.slice(50).map((entry) => entry.client)).size).toBe(1);
		expect(managed[0]?.workspaceRoot).toBe(firstRoot);
		expect(managed[50]?.workspaceRoot).toBe(secondRoot);
	});

	it("starts exactly one process per definition under same-workspace concurrency", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("server-a"), definition("server-b")], trackedFactory(created));

		const acquisitions = [
			...Array.from({ length: 50 }, () =>
				manager.acquire({ workspaceRoot: root, language: "typescript", definitionId: "server-a" }),
			),
			...Array.from({ length: 50 }, () =>
				manager.acquire({ workspaceRoot: root, language: "typescript", definitionId: "server-b" }),
			),
		];
		const managed = await Promise.all(acquisitions);

		expect(created).toHaveLength(2);
		expect(new Set(managed.slice(0, 50).map((entry) => entry.client)).size).toBe(1);
		expect(new Set(managed.slice(50).map((entry) => entry.client)).size).toBe(1);
	});

	it("uses one replacement for 50 concurrent acquires after a crash", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("crashable")], trackedFactory(created));

		const first = await manager.acquire({ workspaceRoot: root, language: "typescript" });
		await first.client.notify("test/crash-now");
		await waitFor(() => first.client.state === "failed");

		const reacquired = await Promise.all(
			Array.from({ length: 50 }, () => manager.acquire({ workspaceRoot: root, language: "typescript" })),
		);
		expect(created).toHaveLength(2);
		expect(new Set(reacquired.map((entry) => entry.client)).size).toBe(1);
		expect(first.client.state).toBe("closed");
		expect(first.client.processInfo.state).toBe("disposed");
	});

	it("does not deadlock disposing a server while real initialize is pending", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("blocked", "init-delay")], trackedFactory(created));
		const acquiring = manager.acquire({ workspaceRoot: root, language: "typescript" });
		await created[0]?.initializeStarted;

		const disposing = manager.disposeServer({ definitionId: "blocked", workspaceRoot: root });
		const outcomes = await withTimeout(Promise.allSettled([acquiring, disposing]));
		const acquiringOutcome = outcomes[0];
		expect(acquiringOutcome?.status).toBe("rejected");
		if (acquiringOutcome?.status === "rejected") {
			expect(acquiringOutcome.reason).toBeInstanceOf(LanguageServerInstanceDisposedError);
		}
		expect(outcomes[1]?.status).toBe("fulfilled");
		expect(created[0]?.client.state).toBe("closed");
		expect(created[0]?.client.pendingRequestCount).toBe(0);
		expect(created[0]?.client.processInfo.state).toBe("disposed");
		expect(manager.getServers()).toHaveLength(0);
	});

	it("settles manager.dispose while multiple real initializations are pending", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor(
			[definition("server-a", "init-delay"), definition("server-b", "init-delay")],
			trackedFactory(created),
		);
		const acquiring = [
			manager.acquire({ workspaceRoot: root, language: "typescript", definitionId: "server-a" }),
			manager.acquire({ workspaceRoot: root, language: "typescript", definitionId: "server-b" }),
		];
		await Promise.all(created.map((entry) => entry.initializeStarted));

		const disposing = manager.dispose();
		const outcomes = await withTimeout(Promise.allSettled([...acquiring, disposing]));
		expect(outcomes.slice(0, 2).every((outcome) => outcome.status === "rejected")).toBe(true);
		expect(outcomes[2]?.status).toBe("fulfilled");
		expect(created.every((entry) => entry.client.state === "closed")).toBe(true);
		expect(created.every((entry) => entry.client.pendingRequestCount === 0)).toBe(true);
		expect(created.every((entry) => entry.client.processInfo.state === "disposed")).toBe(true);
		expect(manager.getServers()).toHaveLength(0);
	});

	it("disposeAll closes every managed real process and clears the registry", async () => {
		const firstRoot = await workspace();
		const secondRoot = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("server-a"), definition("server-b")], trackedFactory(created));

		await Promise.all([
			manager.acquire({ workspaceRoot: firstRoot, language: "typescript", definitionId: "server-a" }),
			manager.acquire({ workspaceRoot: firstRoot, language: "typescript", definitionId: "server-b" }),
			manager.acquire({ workspaceRoot: secondRoot, language: "typescript", definitionId: "server-a" }),
		]);
		expect(created).toHaveLength(3);
		expect(manager.getServers()).toHaveLength(3);

		await manager.dispose();

		expect(created.every((entry) => entry.client.state === "closed")).toBe(true);
		expect(created.every((entry) => entry.client.pendingRequestCount === 0)).toBe(true);
		expect(created.every((entry) => entry.client.processInfo.state === "disposed")).toBe(true);
		expect(manager.getServers()).toHaveLength(0);
	});

	it("aggregates disposal failures after every real process is cleaned up", async () => {
		const root = await workspace();
		const created: LspClient[] = [];
		const manager = managerFor(
			[definition("server-a"), definition("server-b")],
			(serverDefinition, workspaceRoot, logger) => {
				const client =
					serverDefinition.id === "server-a"
						? new DisposeReportingFailureClient(
								{
									command: serverDefinition.command,
									args: serverDefinition.args,
									cwd: workspaceRoot,
									env: { ...process.env, ...(serverDefinition.env ?? {}) },
									logger,
								},
								{ ...(serverDefinition.clientOptions ?? {}), logger },
							)
						: createClient(serverDefinition, workspaceRoot, logger);
				created.push(client);
				return client;
			},
		);

		await Promise.all([
			manager.acquire({ workspaceRoot: root, language: "typescript", definitionId: "server-a" }),
			manager.acquire({ workspaceRoot: root, language: "typescript", definitionId: "server-b" }),
		]);

		const error = await manager.dispose().catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(LanguageServerDisposalError);
		expect((error as LanguageServerDisposalError).errors).toHaveLength(1);
		expect(created.every((client) => client.state === "closed")).toBe(true);
		expect(created.every((client) => client.pendingRequestCount === 0)).toBe(true);
		expect(created.every((client) => client.processInfo.state === "disposed")).toBe(true);
		expect(manager.getServers()).toHaveLength(0);
	});

	it("disposes only one workspace while another workspace is still starting", async () => {
		const firstRoot = await workspace();
		const secondRoot = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor(
			[definition("server-a", "init-delay"), definition("server-b", "init-delay")],
			trackedFactory(created),
		);
		const first = manager.acquire({ workspaceRoot: firstRoot, language: "typescript", definitionId: "server-a" });
		const second = manager.acquire({ workspaceRoot: firstRoot, language: "typescript", definitionId: "server-b" });
		const third = manager.acquire({ workspaceRoot: secondRoot, language: "typescript", definitionId: "server-a" });
		await Promise.all(created.map((entry) => entry.initializeStarted));

		const workspaceDisposal = manager.disposeWorkspace(firstRoot);
		const firstOutcomes = await withTimeout(Promise.allSettled([first, second, workspaceDisposal]));
		expect(firstOutcomes[0]?.status).toBe("rejected");
		expect(firstOutcomes[1]?.status).toBe("rejected");
		expect(firstOutcomes[2]?.status).toBe("fulfilled");
		expect(
			created.filter((entry) => entry.workspaceRoot === firstRoot).every((entry) => entry.client.state === "closed"),
		).toBe(true);
		expect(manager.getServers().every((entry) => entry.workspaceRoot !== firstRoot)).toBe(true);

		const other = created.find((entry) => entry.workspaceRoot === secondRoot);
		await other?.client.notify("test/release-init");
		await third;
		expect(other?.client.state).toBe("initialized");
	});

	it("serializes concurrent disposeServer calls and acquire after disposal", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("server")], trackedFactory(created));
		const first = await manager.acquire({ workspaceRoot: root, language: "typescript" });

		const disposals = Promise.all(
			Array.from({ length: 3 }, () => manager.disposeServer({ definitionId: "server", workspaceRoot: root })),
		);
		await disposals;
		expect(first.client.state).toBe("closed");
		expect(created).toHaveLength(1);
		expect(manager.getServers()).toHaveLength(0);

		const second = await manager.acquire({ workspaceRoot: root, language: "typescript" });
		expect(second.client).not.toBe(first.client);
		expect(created).toHaveLength(2);
	});

	it("does not reuse a client that was externally shut down", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("server")], trackedFactory(created));
		const first = await manager.acquire({ workspaceRoot: root, language: "typescript" });

		await first.client.shutdown();
		const second = await manager.acquire({ workspaceRoot: root, language: "typescript" });

		expect(second.client).not.toBe(first.client);
		expect(created).toHaveLength(2);
		expect(first.client.state).toBe("closed");
		expect(first.client.processInfo.state).toBe("disposed");
	});

	it("waits for the old instance before acquire creates a replacement", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("server")], trackedFactory(created));
		const first = await manager.acquire({ workspaceRoot: root, language: "typescript" });

		const disposal = manager.disposeServer({ definitionId: "server", workspaceRoot: root });
		const reacquired = manager.acquire({ workspaceRoot: root, language: "typescript" });
		const [, second] = await Promise.all([disposal, reacquired]);

		expect(second.client).not.toBe(first.client);
		expect(first.client.state).toBe("closed");
		expect(first.client.processInfo.state).toBe("disposed");
		expect(created).toHaveLength(2);
	});
});

describe("Phase 4 Final Acceptance: failure and routing attacks", () => {
	it("does not fall back for an explicitly selected unavailable definition", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor(
			[
				definition("primary", "standard", ["typescript"], 100, missingCommand(root, "primary")),
				definition("secondary", "standard", ["typescript"], 0),
			],
			trackedFactory(created),
		);

		await expect(
			manager.acquire({ workspaceRoot: root, language: "typescript", definitionId: "primary" }),
		).rejects.toBeInstanceOf(LanguageServerUnavailableError);
		expect(created.map((entry) => entry.definitionId)).toEqual(["primary"]);
		expect(manager.getServers()).toHaveLength(0);
	});

	it("shares one fallback client across 50 concurrent unavailable-primary callers", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor(
			[
				definition("primary", "standard", ["typescript"], 100, missingCommand(root, "primary")),
				definition("secondary"),
			],
			trackedFactory(created),
		);

		const managed = await Promise.all(
			Array.from({ length: 50 }, () => manager.acquire({ workspaceRoot: root, language: "typescript" })),
		);

		expect(created.map((entry) => entry.definitionId)).toEqual(["primary", "secondary"]);
		expect(new Set(managed.map((entry) => entry.client)).size).toBe(1);
		expect(managed[0]?.definition.id).toBe("secondary");
		expect(created[0]?.client.state).toBe("closed");
		expect(created[0]?.client.processInfo.state).toBe("disposed");
	});

	it("keeps all-unavailable semantics and removes every failed cache entry", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor(
			[
				definition("primary", "standard", ["typescript"], 100, missingCommand(root, "primary")),
				definition("secondary", "standard", ["typescript"], 50, missingCommand(root, "secondary")),
			],
			trackedFactory(created),
		);

		const error = await manager
			.acquire({ workspaceRoot: root, language: "typescript" })
			.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(LanguageServerUnavailableError);
		expect((error as LanguageServerUnavailableError).definitionId).toBe("secondary");
		expect(created).toHaveLength(2);
		expect(created.every((entry) => entry.client.state === "closed")).toBe(true);
		expect(manager.getServers()).toHaveLength(0);
	});

	it("does not fall back after a process crash during initialize", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor(
			[definition("crashing-primary", "init-crash", ["typescript"], 100), definition("secondary")],
			trackedFactory(created),
		);

		await expect(manager.acquire({ workspaceRoot: root, language: "typescript" })).rejects.toBeInstanceOf(
			LanguageServerInitializeError,
		);
		expect(created.map((entry) => entry.definitionId)).toEqual(["crashing-primary"]);
		expect(created[0]?.client.state).toBe("closed");
		expect(created[0]?.client.processInfo.state).toBe("disposed");
		expect(manager.getServers()).toHaveLength(0);
	});

	it("cleans a factory failure and a client.start failure without poisoning the cache", async () => {
		const root = await workspace();
		let factoryCalls = 0;
		const factoryManager = managerFor([definition("factory-fails")], () => {
			factoryCalls += 1;
			throw new Error("factory failure");
		});
		await expect(factoryManager.acquire({ workspaceRoot: root, language: "typescript" })).rejects.toBeInstanceOf(
			LanguageServerStartError,
		);
		expect(factoryCalls).toBe(1);
		expect(factoryManager.getServers()).toHaveLength(0);

		class StartFailingClient extends LspClient {
			override async start(): Promise<void> {
				throw new Error("start failure");
			}
		}
		let startClient: StartFailingClient | undefined;
		const startManager = managerFor([definition("start-fails")], (serverDefinition, workspaceRoot, logger) => {
			const client = new StartFailingClient(
				{
					command: serverDefinition.command,
					args: serverDefinition.args,
					cwd: workspaceRoot,
					env: { ...process.env, ...(serverDefinition.env ?? {}) },
					logger,
				},
				{ ...(serverDefinition.clientOptions ?? {}), logger },
			);
			startClient = client;
			return client;
		});
		await expect(startManager.acquire({ workspaceRoot: root, language: "typescript" })).rejects.toBeInstanceOf(
			LanguageServerStartError,
		);
		expect(startClient?.state).toBe("closed");
		expect(startClient?.processInfo.state).toBe("disposed");
		expect(startManager.getServers()).toHaveLength(0);
	});
});

describe("Phase 4 Final Acceptance: registry and identity attacks", () => {
	it("protects nested definition configuration and candidate result arrays", () => {
		const input: LanguageServerDefinitionInput = {
			id: "nested",
			languages: [" TypeScript "],
			command: "mock",
			args: ["--stdio"],
			env: { TEST_TOKEN: "original" },
			clientOptions: { defaultRequestTimeoutMs: 10_000 },
			capabilities: { workspace: { nested: { enabled: true } } },
		};
		const registry = new LanguageServerRegistry();
		registry.register(input);
		(input.languages as string[])[0] = "python";
		(input.args as string[])[0] = "--changed";
		if (input.env) input.env.TEST_TOKEN = "changed";
		if (input.capabilities) {
			(input.capabilities.workspace as { nested: { enabled: boolean } }).nested.enabled = false;
		}

		const registered = registry.get("nested");
		const candidates = registry.getCandidates("typescript");
		expect(registered?.languages).toEqual(["typescript"]);
		expect(registered?.args).toEqual(["--stdio"]);
		expect(registered?.env?.TEST_TOKEN).toBe("original");
		expect((registered?.capabilities?.workspace as { nested: { enabled: boolean } }).nested.enabled).toBe(true);
		expect(Object.isFrozen(registered?.env)).toBe(true);
		expect(Object.isFrozen(registered?.capabilities?.workspace)).toBe(true);
		expect(Object.isFrozen(candidates)).toBe(true);
		expect(candidates.map((entry) => entry.id)).toEqual(["nested"]);
	});

	it("keeps explicit definition selection separate from ordinary priority routing", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor(
			[
				definition("preferred", "standard", ["typescript"], 100),
				definition("explicit", "standard", ["typescript"], 0),
			],
			trackedFactory(created),
		);

		const explicit = await manager.acquire({ workspaceRoot: root, language: "typescript", definitionId: "explicit" });
		const ordinary = await manager.acquire({ workspaceRoot: root, language: "typescript" });

		expect(explicit.definition.id).toBe("explicit");
		expect(ordinary.definition.id).toBe("preferred");
		expect(created).toHaveLength(2);
	});

	it("normalizes relative, dotted, slash, trailing, spaces, and Unicode workspace paths", async () => {
		const root = await workspace("workspace with spaces 中文");
		const nested = join(root, "nested");
		await mkdir(nested);
		const manager = managerFor([definition("server")]);
		const first = await manager.acquire({ workspaceRoot: root, language: "typescript" });
		const variants = [
			`${root}${sep}`,
			root.replaceAll("\\", "/"),
			join(root, "nested", ".."),
			relative(process.cwd(), root),
		];
		for (const variant of variants) {
			const next = await manager.acquire({ workspaceRoot: variant, language: "typescript" });
			expect(next.client).toBe(first.client);
		}
		if (process.platform === "win32") {
			const caseVariant = root
				.split("\\")
				.map((segment) => segment.toUpperCase())
				.join("\\");
			const next = await manager.acquire({ workspaceRoot: caseVariant, language: "typescript" });
			expect(next.client).toBe(first.client);
		}
		expect(basename(root)).toContain("中文");
	});

	it("rejects invalid workspace roots before creating a client", async () => {
		const root = await workspace();
		const created: CreatedClient[] = [];
		const manager = managerFor([definition("server")], trackedFactory(created));
		await expect(
			manager.acquire({ workspaceRoot: join(root, "does-not-exist"), language: "typescript" }),
		).rejects.toBeInstanceOf(InvalidWorkspaceRootError);
		expect(created).toHaveLength(0);
	});
});
