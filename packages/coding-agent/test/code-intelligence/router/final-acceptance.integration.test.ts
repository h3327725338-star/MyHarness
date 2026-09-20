import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { LightweightCodeIntelligenceBackend } from "../../../src/symbols/index/lightweight/backend.ts";
import { CodeIntelligenceRouter } from "../../../src/symbols/index/router/router.ts";
import { LspRequestAbortedError, LspRequestTimeoutError } from "../../../src/symbols/lsp/errors.ts";
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
	for (const environment of environments) {
		try {
			await environment.semantic.dispose();
		} catch {
			// Continue cleanup so a failed test cannot retain the manager process.
		}
		try {
			await environment.manager.dispose();
		} catch {
			// The manager owns the child process; continue temporary-directory cleanup.
		}
		await rm(environment.root, { recursive: true, force: true });
		await rm(environment.agentDir, { recursive: true, force: true });
	}
	environments.clear();
});

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

function definition(
	fixture: string,
	scenario: string,
	clientOptions?: Omit<LspClientOptions, "logger">,
	command = process.execPath,
): LanguageServerDefinitionInput {
	return {
		id: "phase6-final-acceptance",
		languages: ["typescript"],
		command,
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
		readonly command?: string;
	} = {},
): Promise<Environment> {
	const root = await mkdtemp(join(tmpdir(), "myharness-phase6-final-router-"));
	const agentDir = await mkdtemp(join(tmpdir(), "myharness-phase6-final-agent-"));
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "target.ts"), "export class Target {\n  run() {}\n}\n", "utf8");
	await writeFile(join(root, "src", "source.ts"), "const value = new Target();\nvalue.run();\n", "utf8");

	const registry = new LanguageServerRegistry();
	if (options.registerServer !== false) {
		registry.register(
			definition(
				options.fixture ?? SEMANTIC_FIXTURE,
				options.scenario ?? "full-sync",
				options.clientOptions,
				options.command,
			),
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
				reject(new Error("timed out waiting for final acceptance integration state"));
				return;
			}
			setTimeout(check, 10);
		};
		check();
	});
}

describe("CodeIntelligenceRouter Final Acceptance real integration", () => {
	it("uses the real semantic backend for success and never falls back on semantic empty", async () => {
		const success = await createEnvironment({ scenario: "full-sync" });
		const successLightweight = vi.spyOn(success.lightweight, "fileSymbols");
		const successResult = await success.router.fileSymbols("src/target.ts");
		expect(successResult.meta.source).toBe("semantic");
		expect(successResult.items.length).toBeGreaterThan(0);
		expect(successLightweight).not.toHaveBeenCalled();

		const empty = await createEnvironment({ scenario: "document-symbol-null" });
		const emptyLightweight = vi.spyOn(empty.lightweight, "fileSymbols");
		const emptyResult = await empty.router.fileSymbols("src/target.ts");
		expect(emptyResult).toEqual({ items: [], meta: { source: "semantic", completeness: "complete" } });
		expect(emptyLightweight).not.toHaveBeenCalled();
	});

	it.each([
		["unsupported-document-symbol", "semantic_capability_unsupported"],
		["unsupported-position", "semantic_position_encoding_unsupported"],
	] as const)("uses real safe fallback classification for %s", async (scenario, reason) => {
		const environment = await createEnvironment({ scenario });
		const result = await environment.router.fileSymbols("src/target.ts");

		expect(result.meta).toMatchObject({ source: "lightweight", fallback: { reason } });
		expect(result.items.length).toBeGreaterThan(0);
	});

	it("falls back for real no-server and executable-unavailable failures", async () => {
		const noServer = await createEnvironment({ registerServer: false });
		const noServerResult = await noServer.router.fileSymbols("src/target.ts");
		expect(noServerResult.meta.fallback?.reason).toBe("semantic_server_unavailable");

		const missing = await createEnvironment({ command: join(tmpdir(), "phase6-command-does-not-exist.exe") });
		const missingResult = await missing.router.fileSymbols("src/target.ts");
		expect(missingResult.meta.fallback?.reason).toBe("semantic_server_unavailable");
	});

	it.each([
		["init-error", "initialize"],
		["document-symbol-error", "request"],
		["malformed-result", "response"],
	] as const)("never falls back for real %s failures", async (scenario, failureKind) => {
		const environment = await createEnvironment({
			fixture:
				scenario === "init-error" || scenario === "document-symbol-error" ? MOCK_LSP_FIXTURE : SEMANTIC_FIXTURE,
			scenario,
		});
		const lightweight = vi.spyOn(environment.lightweight, "fileSymbols");

		const error = await environment.router.fileSymbols("src/target.ts").catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(SemanticBackendError);
		expect(lightweight).not.toHaveBeenCalled();
		if (failureKind === "initialize") {
			expect(
				hasCause(error, (cause) => cause instanceof Error && cause.name === "LanguageServerInitializeError"),
			).toBe(true);
		} else if (failureKind === "request") {
			expect((error as SemanticBackendError).code).toBe("request_failed");
		} else {
			expect((error as SemanticBackendError).code).toBe("invalid_server_response");
		}
	});

	it("does not fallback on a real abort and cleans all child-owned state", async () => {
		const environment = await createEnvironment({ scenario: "gate-first-symbol" });
		const lightweight = vi.spyOn(environment.lightweight, "fileSymbols");
		const controller = new AbortController();
		const request = environment.router.fileSymbols("src/target.ts", { signal: controller.signal });

		await waitFor(() =>
			environment.semantic.getSessions().some((session) => session.documents.some((document) => document.open)),
		);
		controller.abort();
		const error = await request.catch((cause: unknown) => cause);

		expect(lightweight).not.toHaveBeenCalled();
		expect(
			hasCause(error, (cause) => cause instanceof LspRequestAbortedError || (cause as Error)?.name === "AbortError"),
		).toBe(true);

		await environment.semantic.dispose();
		await environment.manager.dispose();
		expect(environment.semantic.getSessions()).toHaveLength(0);
		expect(environment.manager.getServers()).toHaveLength(0);
	});

	it("does not fallback on timeout and retries semantic after timeout recovery", async () => {
		const environment = await createEnvironment({
			scenario: "timeout-once",
			clientOptions: { defaultRequestTimeoutMs: 1_000 },
		});
		const lightweight = vi.spyOn(environment.lightweight, "fileSymbols");

		const first = await environment.router
			.fileSymbols("src/target.ts", { timeoutMs: 10 })
			.catch((cause: unknown) => cause);
		expect(first).toBeInstanceOf(SemanticBackendError);
		expect((first as SemanticBackendError).code).toBe("request_failed");
		expect(hasCause(first, (cause) => cause instanceof LspRequestTimeoutError)).toBe(true);
		expect(lightweight).not.toHaveBeenCalled();

		const second = await environment.router.fileSymbols("src/target.ts", { timeoutMs: 1_000 });
		expect(second.meta.source).toBe("semantic");
		expect(second.items.length).toBeGreaterThan(0);
		expect(lightweight).not.toHaveBeenCalled();
	});
});
