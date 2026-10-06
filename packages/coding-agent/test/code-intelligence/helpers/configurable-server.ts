import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LanguageServerManager } from "../../../src/symbols/lsp/language-server/manager.ts";
import { LanguageServerRegistry } from "../../../src/symbols/lsp/language-server/registry.ts";
import { LspSemanticBackend } from "../../../src/symbols/semantic/backend.ts";

const SERVER = fileURLToPath(new URL("../fixtures/configurable-lsp-server.mjs", import.meta.url));

export interface MockServerConfig {
	capabilities?: Record<string, unknown>;
	documentSymbols?: Record<string, unknown>;
	workspaceSymbols?: ReadonlyArray<Record<string, unknown>>;
	workspaceSymbolsByLastOpened?: Record<string, ReadonlyArray<Record<string, unknown>>>;
	workspaceSymbolDelayMs?: number;
	workspaceSymbolError?: { code: number; message: string };
	rawWorkspaceSymbols?: unknown;
	filterByQuery?: boolean;
	/** Answers for any other request, by method; see configurable-lsp-server.mjs for the special forms. */
	responses?: Record<string, unknown>;
	/** WorkspaceEdit the server sends as workspace/applyEdit when it receives workspace/executeCommand. */
	applyEditOnCommand?: Record<string, unknown>;
	/** Sent verbatim as the params of workspace/applyEdit (to test malformed requests). */
	applyEditRawParams?: Record<string, unknown>;
}

export interface MockServerDefinition {
	id: string;
	languages: string[];
	config: MockServerConfig;
	priority?: number;
	/** Client capability override of the definition (narrow-only, see client-capabilities.ts). */
	capabilities?: Record<string, unknown>;
	/** Environment of the server process, as the managed runtime definitions carry it. */
	env?: Record<string, string>;
}

export interface LoggedEntry {
	kind: string;
	[key: string]: unknown;
}

export interface MockEnvironment {
	root: string;
	registry: LanguageServerRegistry;
	manager: LanguageServerManager;
	backend: LspSemanticBackend;
	/** Entries the server of the given definition logged (initialize, requests, didOpen/didClose). */
	log(definitionId: string): LoggedEntry[];
	write(relativePath: string, content: string): void;
	dispose(): Promise<void>;
}

export const FULL_CAPABILITIES = {
	textDocumentSync: { openClose: true, change: 1 },
	documentSymbolProvider: true,
	definitionProvider: true,
	referencesProvider: true,
	implementationProvider: true,
	workspaceSymbolProvider: true,
	positionEncoding: "utf-16",
};

export const RENAME_CAPABILITIES = { ...FULL_CAPABILITIES, renameProvider: { prepareProvider: true } };

export function createMockEnvironment(
	definitions: readonly MockServerDefinition[],
	options: { applyEditTimeoutMs?: number } = {},
): MockEnvironment {
	const root = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-mock-lsp-"));
	const logFiles = new Map<string, string>();
	const registry = new LanguageServerRegistry();
	for (const definition of definitions) {
		const configPath = join(root, `.mock-${definition.id}.json`);
		const logFile = join(root, `.mock-${definition.id}.log`);
		logFiles.set(definition.id, logFile);
		writeFileSync(configPath, JSON.stringify({ ...definition.config, logFile }), "utf8");
		registry.register({
			id: definition.id,
			languages: definition.languages,
			command: process.execPath,
			args: [SERVER, configPath],
			priority: definition.priority,
			capabilities: definition.capabilities as never,
			env: definition.env ? { ...process.env, ...definition.env } : undefined,
		});
	}
	const manager = new LanguageServerManager({ registry });
	const backend = new LspSemanticBackend({ manager, applyEditTimeoutMs: options.applyEditTimeoutMs });
	return {
		root,
		registry,
		manager,
		backend,
		log(definitionId) {
			const file = logFiles.get(definitionId);
			if (!file) return [];
			try {
				return readFileSync(file, "utf8")
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as LoggedEntry);
			} catch {
				return [];
			}
		},
		write(relativePath, content) {
			const target = join(root, ...relativePath.split("/"));
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content, "utf8");
		},
		async dispose() {
			await backend.dispose().catch(() => undefined);
			await manager.dispose().catch(() => undefined);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
	return {
		start: { line: startLine, character: startCharacter },
		end: { line: endLine, character: endCharacter },
	};
}
