import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { LightweightCodeIntelligenceBackend } from "../../../src/symbols/index/lightweight/backend.ts";
import { CodeIntelligenceRouter } from "../../../src/symbols/index/router/router.ts";
import { LspRequestAbortedError } from "../../../src/symbols/lsp/errors.ts";
import { LanguageServerManager } from "../../../src/symbols/lsp/language-server/manager.ts";
import {
	type LanguageServerDefinitionInput,
	LanguageServerRegistry,
} from "../../../src/symbols/lsp/language-server/registry.ts";
import type { LspClientOptions } from "../../../src/symbols/lsp/types.ts";
import { LspSemanticBackend } from "../../../src/symbols/semantic/backend.ts";
import { SemanticBackendError } from "../../../src/symbols/semantic/errors.ts";

const SEMANTIC_FIXTURE = fileURLToPath(new URL("../semantic/fixtures/semantic-lsp-server.mjs", import.meta.url));
const MOCK_LSP_FIXTURE = fileURLToPath(new URL("../lsp/fixtures/mock-lsp-server.mjs", import.meta.url));

interface Environment {
	readonly root: string;
	readonly agentDir: string;
	readonly manager: LanguageServerManager;
	readonly semantic: LspSemanticBackend;
	readonly lightweight: LightweightCodeIntelligenceBackend;
	readonly router: CodeIntelligenceRouter;
}

const environments = new Set<Environment>();

afterEach(async () => {
	vi.restoreAllMocks();
	for (const environment of environments) {
		try {
			await environment.semantic.dispose();
		} catch {
			// Continue manager and temporary-directory cleanup after a failed disposal.
		}
		try {
			await environment.manager.dispose();
		} catch {
			// The manager owns child processes; cleanup must continue for later tests.
		}
		await rm(environment.root, { recursive: true, force: true });
		await rm(environment.agentDir, { recursive: true, force: true });
	}
	environments.clear();
});

function definition(
	fixture: string,
	scenario: string,
	clientOptions?: Omit<LspClientOptions, "logger">,
): LanguageServerDefinitionInput {
	return {
		id: "phase6-fixture",
		languages: ["typescript"],
		command: process.execPath,
		args: [fixture, scenario],
		clientOptions,
	};
}

async function createEnvironment(
	options: {
		readonly fixture?: string;
		readonly scenario?: string;
		readonly registerServer?: boolean;
		readonly clientOptions?: Omit<LspClientOptions, "logger">;
	} = {},
): Promise<Environment> {
	const root = await mkdtemp(join(tmpdir(), "myharness-phase6-router-integration-"));
	const agentDir = await mkdtemp(join(tmpdir(), "myharness-phase6-router-agent-"));
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "target.ts"), "export class Target {\n  run() {}\n}\n", "utf8");
	await writeFile(join(root, "src", "source.ts"), "const value = new Target();\nvalue.run();\n", "utf8");

	const registry = new LanguageServerRegistry();
	if (options.registerServer !== false) {
		registry.register(
			definition(options.fixture ?? SEMANTIC_FIXTURE, options.scenario ?? "full-sync", options.clientOptions),
		);
	}
	const manager = new LanguageServerManager({ registry });
	const semantic = new LspSemanticBackend({ manager });
	const lightweight = new LightweightCodeIntelligenceBackend({ workspaceRoot: root, agentDir });
	const router = new CodeIntelligenceRouter({ workspaceRoot: root, semantic, lightweight });
	const environment = { root, agentDir, manager, semantic, lightweight, router };
	environments.add(environment);
	return environment;
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise<void>((resolve, reject) => {
		const check = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error("timed out waiting for phase 6 integration state"));
				return;
			}
			setTimeout(check, 10);
		};
		check();
	});
}

function hasCause(error: unknown, predicate: (value: unknown) => boolean): boolean {
	const queue: unknown[] = [error];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);
		if (predicate(current)) return true;
		if (current instanceof Error) {
			if (current.cause !== undefined) queue.push(current.cause);
			if (current instanceof AggregateError) queue.push(...current.errors);
		}
	}
	return false;
}

describe("CodeIntelligenceRouter real semantic integration", () => {
	it("routes through the real LSP child process and preserves semantic empty results", async () => {
		const environment = await createEnvironment({ scenario: "document-symbol-null" });

		const result = await environment.router.fileSymbols("src/target.ts");

		expect(result).toEqual({ items: [], meta: { source: "semantic", completeness: "complete" } });
		expect(environment.lightweight).toBeDefined();
		expect(environment.semantic.getSessions()).toHaveLength(1);
		expect(environment.manager.getServers()).toMatchObject([
			{ definitionId: "phase6-fixture", state: "ready", clientState: "initialized" },
		]);
	});

	it.each([
		["unsupported-document-symbol", "semantic_capability_unsupported"],
		["unsupported-position", "semantic_position_encoding_unsupported"],
	] as const)("falls back only for safe semantic capability failure: %s", async (scenario, reason) => {
		const environment = await createEnvironment({ scenario });
		const lightweight = vi.spyOn(environment.lightweight, "fileSymbols");

		const result = await environment.router.fileSymbols("src/target.ts");

		expect(result.meta.source).toBe("lightweight");
		expect(result.meta.fallback).toMatchObject({ reason });
		expect(result.items.length).toBeGreaterThan(0);
		expect(lightweight).toHaveBeenCalledOnce();
	});

	it("falls back for a real no-server acquisition failure", async () => {
		const environment = await createEnvironment({ registerServer: false });
		const lightweight = vi.spyOn(environment.lightweight, "fileSymbols");

		const result = await environment.router.fileSymbols("src/target.ts");

		expect(result.meta.fallback?.reason).toBe("semantic_server_unavailable");
		expect(result.meta.source).toBe("lightweight");
		expect(lightweight).toHaveBeenCalledOnce();
	});

	it("does not fall back after a real language-server initialize failure", async () => {
		const environment = await createEnvironment({ fixture: MOCK_LSP_FIXTURE, scenario: "init-error" });
		const lightweight = vi.spyOn(environment.lightweight, "fileSymbols");

		const error = await environment.router.fileSymbols("src/target.ts").catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(SemanticBackendError);
		expect((error as SemanticBackendError).code).toBe("server_unavailable");
		expect(hasCause(error, (cause) => cause instanceof Error && cause.name === "LanguageServerInitializeError")).toBe(
			true,
		);
		expect(lightweight).not.toHaveBeenCalled();
	});

	it("does not fall back on a real aborted semantic request", async () => {
		const environment = await createEnvironment({
			scenario: "timeout-once",
			clientOptions: { defaultRequestTimeoutMs: 1_000 },
		});
		const lightweight = vi.spyOn(environment.lightweight, "fileSymbols");
		const controller = new AbortController();
		const request = environment.router.fileSymbols("src/target.ts", { signal: controller.signal });

		await waitFor(() =>
			environment.semantic.getSessions().some((session) => session.documents.some((document) => document.open)),
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		controller.abort();
		const error = await request.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(SemanticBackendError);
		expect(hasCause(error, (cause) => cause instanceof LspRequestAbortedError)).toBe(true);
		expect(lightweight).not.toHaveBeenCalled();
	});

	it("disposes the real backend and manager without retained sessions or servers", async () => {
		const environment = await createEnvironment({ scenario: "full-sync" });
		await environment.router.fileSymbols("src/target.ts");

		await environment.semantic.dispose();
		await environment.manager.dispose();

		expect(environment.semantic.getSessions()).toHaveLength(0);
		expect(environment.manager.getServers()).toHaveLength(0);
	});
});
