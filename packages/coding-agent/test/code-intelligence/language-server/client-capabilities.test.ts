import { afterEach, describe, expect, it } from "vitest";
import {
	createProductClientCapabilities,
	mergeClientCapabilities,
	PRODUCT_CLIENT_FEATURES,
	resolveClientCapabilities,
} from "../../../src/symbols/lsp/language-server/client-capabilities.ts";
import { createMockEnvironment, FULL_CAPABILITIES, type MockEnvironment } from "../helpers/configurable-server.ts";

const environments: MockEnvironment[] = [];

afterEach(async () => {
	for (const environment of environments.splice(0)) await environment.dispose();
});

type Json = Record<string, any>;

describe("product client capability profile", () => {
	it("advertises what the semantic backend implements and nothing else", () => {
		const capabilities = createProductClientCapabilities(PRODUCT_CLIENT_FEATURES) as Json;

		expect(capabilities.general.positionEncodings).toEqual(["utf-16"]);
		expect(capabilities.textDocument.documentSymbol.hierarchicalDocumentSymbolSupport).toBe(true);
		expect(capabilities.textDocument.callHierarchy).toBeDefined();
		expect(capabilities.textDocument.publishDiagnostics.versionSupport).toBe(true);
		expect(capabilities.workspace.symbol).toBeDefined();
		expect(capabilities.textDocument.rename).toEqual({
			dynamicRegistration: false,
			prepareSupport: true,
			prepareSupportDefaultBehavior: 1,
		});
		// Text edits only: no file operations are advertised, so servers do not send any.
		expect(capabilities.workspace.workspaceEdit).toEqual({
			documentChanges: true,
			resourceOperations: [],
			normalizesLineEndings: true,
			changeAnnotationSupport: { groupsOnLabel: false },
		});
		// Not implemented yet: advertising them would make servers send requests the client cannot answer.
		expect(capabilities.textDocument.diagnostic).toBeUndefined();
		expect(capabilities.workspace.applyEdit).toBeUndefined();
		expect(capabilities.workspace.workspaceEdit.failureHandling).toBeUndefined();
	});

	it("leaves rename and workspace edits out when the features are off", () => {
		const capabilities = createProductClientCapabilities({
			rename: false,
			applyEdit: false,
			pullDiagnostics: false,
			diagnosticRefresh: false,
		}) as Json;

		expect(capabilities.textDocument.rename).toBeUndefined();
		expect(capabilities.workspace.workspaceEdit).toBeUndefined();
		expect(capabilities.workspace.applyEdit).toBeUndefined();
	});

	it("adds the applyEdit and pull diagnostic branches only when their feature is on", () => {
		const capabilities = createProductClientCapabilities({
			rename: true,
			applyEdit: true,
			pullDiagnostics: true,
			diagnosticRefresh: true,
		}) as Json;

		expect(capabilities.textDocument.diagnostic.relatedDocumentSupport).toBe(true);
		expect(capabilities.workspace.applyEdit).toBe(true);
		expect(capabilities.workspace.workspaceEdit.failureHandling).toBe("abort");
		expect(capabilities.workspace.workspaceEdit.resourceOperations).toEqual([]);
		expect(capabilities.workspace.diagnostics.refreshSupport).toBe(true);
	});
});

describe("capability override merge", () => {
	it("merges nested branches instead of replacing the whole textDocument section", () => {
		const { capabilities, rejected } = resolveClientCapabilities({
			textDocument: { hover: { contentFormat: ["plaintext"] } },
		}) as { capabilities: Json; rejected: string[] };

		expect(rejected).toEqual([]);
		expect(capabilities.textDocument.hover.contentFormat).toEqual(["plaintext"]);
		expect(capabilities.textDocument.documentSymbol.hierarchicalDocumentSymbolSupport).toBe(true);
		expect(capabilities.workspace.symbol).toBeDefined();
	});

	it("lets an override remove a branch or disable a flag", () => {
		const { capabilities } = resolveClientCapabilities({
			textDocument: {
				callHierarchy: null,
				documentSymbol: { hierarchicalDocumentSymbolSupport: false },
			},
		}) as { capabilities: Json };

		expect(capabilities.textDocument.callHierarchy).toBeUndefined();
		expect(capabilities.textDocument.documentSymbol.hierarchicalDocumentSymbolSupport).toBe(false);
	});

	it("drops and reports leaves that would enable something the profile does not advertise", () => {
		const { capabilities, rejected } = resolveClientCapabilities({
			textDocument: { diagnostic: { dynamicRegistration: false }, hover: { dynamicRegistration: true } },
			workspace: { applyEdit: true },
		}) as { capabilities: Json; rejected: string[] };

		expect(capabilities.textDocument.diagnostic).toBeUndefined();
		expect(capabilities.workspace.applyEdit).toBeUndefined();
		expect(capabilities.textDocument.hover.dynamicRegistration).toBe(false);
		expect(rejected.sort()).toEqual([
			"textDocument.diagnostic",
			"textDocument.hover.dynamicRegistration",
			"workspace.applyEdit",
		]);
	});

	it("never mutates the base profile", () => {
		const base = createProductClientCapabilities();
		const before = JSON.stringify(base);

		mergeClientCapabilities(base, { textDocument: { callHierarchy: null } });

		expect(JSON.stringify(base)).toBe(before);
	});
});

describe("capabilities sent to a real server process", () => {
	it("disables syntax-server fallback for TypeScript before the first semantic query", async () => {
		const environment = createMockEnvironment([
			{
				id: "typescript-language-server",
				languages: ["typescript"],
				config: { capabilities: FULL_CAPABILITIES, documentSymbols: { "src/a.ts": [] } },
			},
		]);
		environments.push(environment);
		environment.write("src/a.ts", "export const a = 1;\n");
		await environment.backend.fileSymbols("src/a.ts", {
			workspaceRoot: environment.root,
			timeoutMs: 10_000,
		});
		const initialize = environment.log("typescript-language-server").find((entry) => entry.kind === "initialize");
		expect(initialize).toMatchObject({
			params: { initializationOptions: { tsserver: { useSyntaxServer: "never" } } },
		});
	});

	it("initialize carries the product profile with the definition override applied", async () => {
		const environment = createMockEnvironment([
			{
				id: "mock-ts",
				languages: ["typescript"],
				config: { capabilities: FULL_CAPABILITIES, documentSymbols: { "src/a.ts": [] } },
				capabilities: { textDocument: { hover: null } },
			},
		]);
		environments.push(environment);
		environment.write("src/a.ts", "export const a = 1;\n");

		await environment.backend.fileSymbols("src/a.ts", {
			workspaceRoot: environment.root,
			language: "typescript",
			timeoutMs: 10_000,
		});

		const initialize = environment.log("mock-ts").find((entry) => entry.kind === "initialize") as unknown as {
			params: { capabilities: Json };
		};
		expect(initialize.params).not.toHaveProperty("initializationOptions");
		const sent = initialize.params.capabilities;
		expect(sent.textDocument.documentSymbol.hierarchicalDocumentSymbolSupport).toBe(true);
		expect(sent.textDocument.callHierarchy).toBeDefined();
		expect(sent.textDocument.hover).toBeUndefined();
		expect(sent.general.positionEncodings).toEqual(["utf-16"]);
		expect(sent.workspace.applyEdit).toBeUndefined();
	});
});
