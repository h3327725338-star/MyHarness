import { describe, expect, it } from "vitest";
import type { JsonObject, LspInitializeResult } from "../../../src/symbols/lsp/types.ts";
import { parseSemanticCapabilities } from "../../../src/symbols/semantic/capabilities.ts";
import {
	SemanticBackendError,
	SemanticUnsupportedPositionEncodingError,
} from "../../../src/symbols/semantic/errors.ts";

function initializeResult(capabilities: JsonObject): LspInitializeResult {
	return { capabilities };
}

describe("semantic capability parsing", () => {
	it.each([
		[0, "none", false],
		[1, "full", false],
		[2, "incremental", false],
	] as const)("parses numeric textDocumentSync %s", (value, textDocumentSync, openClose) => {
		const result = parseSemanticCapabilities(initializeResult({ textDocumentSync: value }));
		expect(result.textDocumentSync).toBe(textDocumentSync);
		expect(result.openClose).toBe(openClose);
	});

	it("parses TextDocumentSyncOptions defaults conservatively", () => {
		expect(
			parseSemanticCapabilities(initializeResult({ textDocumentSync: { openClose: true, change: 2 } })),
		).toMatchObject({
			textDocumentSync: "incremental",
			openClose: true,
		});
		expect(parseSemanticCapabilities(initializeResult({ textDocumentSync: { change: 1 } }))).toMatchObject({
			textDocumentSync: "full",
			openClose: false,
		});
		expect(parseSemanticCapabilities(initializeResult({ textDocumentSync: { openClose: true } }))).toMatchObject({
			textDocumentSync: "none",
			openClose: true,
		});
		expect(parseSemanticCapabilities(initializeResult({}))).toMatchObject({
			textDocumentSync: "none",
			openClose: false,
		});
	});

	it("recognizes provider true/object and rejects false/undefined", () => {
		const result = parseSemanticCapabilities(
			initializeResult({
				documentSymbolProvider: true,
				definitionProvider: {},
				referencesProvider: false,
				implementationProvider: undefined,
			}),
		);
		expect(result.documentSymbolProvider).toBe(true);
		expect(result.definitionProvider).toBe(true);
		expect(result.referencesProvider).toBe(false);
		expect(result.implementationProvider).toBe(false);
	});

	it("defaults missing positionEncoding to UTF-16", () => {
		expect(parseSemanticCapabilities(initializeResult({})).positionEncoding).toBe("utf-16");
		expect(parseSemanticCapabilities(initializeResult({ positionEncoding: "UTF-16" })).positionEncoding).toBe(
			"utf-16",
		);
	});

	it.each(["utf-8", "utf-32", 16, null])("rejects unsupported position encoding %s", (encoding) => {
		expect(() => parseSemanticCapabilities(initializeResult({ positionEncoding: encoding }))).toThrow(
			SemanticUnsupportedPositionEncodingError,
		);
	});

	it("rejects malformed synchronization capabilities", () => {
		expect(() => parseSemanticCapabilities(initializeResult({ textDocumentSync: "full" }))).toThrow(
			SemanticBackendError,
		);
		expect(() => parseSemanticCapabilities(initializeResult({ textDocumentSync: { change: 3 } }))).toThrow(
			SemanticBackendError,
		);
	});
});
