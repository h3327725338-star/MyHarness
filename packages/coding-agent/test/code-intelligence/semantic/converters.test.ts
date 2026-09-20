import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toFileUri } from "../../../src/symbols/lsp/uri.ts";
import {
	convertWorkspaceLocation,
	documentEndPosition,
	mapDiagnosticSeverity,
	mapLspSymbolKind,
	normalizeLocationKey,
	rangeContainsPosition,
	rangesOverlap,
	toWholeDocumentReplacementRange,
	tryCodePosition,
	tryCodeRange,
} from "../../../src/symbols/semantic/converters.ts";

describe("semantic LSP converters", () => {
	let workspaceRoot: string;

	beforeEach(async () => {
		workspaceRoot = await mkdtemp(join(tmpdir(), "myharness-phase5-converters-"));
	});

	afterEach(async () => {
		await rm(workspaceRoot, { recursive: true, force: true });
	});

	it("keeps UTF-16 code unit positions for emoji and Chinese text", () => {
		const text = "😀变量";
		expect(tryCodePosition({ line: 0, character: 2 }, text)).toEqual({ line: 0, character: 2 });
		expect(tryCodePosition({ line: 0, character: 3 }, text)).toEqual({ line: 0, character: 3 });
		expect(tryCodePosition({ line: 0, character: 4 }, text)).toEqual({ line: 0, character: 4 });
		expect(tryCodePosition({ line: 0, character: 5 }, text)).toBeUndefined();
	});

	it("calculates empty, CRLF, and multiline document ends", () => {
		expect(documentEndPosition("")).toEqual({ line: 0, character: 0 });
		expect(documentEndPosition("a\r\n😀")).toEqual({ line: 1, character: 2 });
		expect(toWholeDocumentReplacementRange("a\r\n😀")).toEqual({
			start: { line: 0, character: 0 },
			end: { line: 1, character: 2 },
		});
		expect(tryCodeRange({ start: { line: 0, character: 0 }, end: { line: 1, character: 2 } }, "a\r\n😀")).toEqual({
			start: { line: 0, character: 0 },
			end: { line: 1, character: 2 },
		});
	});

	it("treats CodeRange ends as exclusive", () => {
		const range = { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } };
		expect(rangeContainsPosition(range, { line: 0, character: 1 })).toBe(true);
		expect(rangeContainsPosition(range, { line: 0, character: 3 })).toBe(false);
		expect(rangesOverlap(range, { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } })).toBe(false);
	});

	it("maps known and unknown LSP symbol kinds and diagnostic severity", () => {
		expect(mapLspSymbolKind(5)).toBe("class");
		expect(mapLspSymbolKind(999)).toBe("unknown");
		expect(mapDiagnosticSeverity(1)).toBe("error");
		expect(mapDiagnosticSeverity(2)).toBe("warning");
		expect(mapDiagnosticSeverity(3)).toBe("information");
		expect(mapDiagnosticSeverity(4)).toBe("hint");
		expect(mapDiagnosticSeverity(99)).toBe("unknown");
		expect(mapDiagnosticSeverity(undefined)).toBeUndefined();
	});

	it("converts file URIs to workspace-relative POSIX paths", () => {
		const uri = toFileUri(join(workspaceRoot, "src", "file.ts"));
		const result = convertWorkspaceLocation(
			uri,
			{ start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
			workspaceRoot,
			"code",
		);
		expect(result).toEqual({
			kind: "ok",
			location: { path: "src/file.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } },
		});
	});

	it("deduplicates location keys across Windows path aliases", () => {
		const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
		expect(normalizeLocationKey({ path: "src/file.ts", range })).toBe(
			normalizeLocationKey({ path: String.raw`SRC\FILE.TS`, range }),
		);
	});

	it("skips outside-workspace and non-file locations without fabricating paths", () => {
		const outside = convertWorkspaceLocation(
			toFileUri(join(workspaceRoot, "..", "outside.ts")),
			{ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			workspaceRoot,
		);
		const nonFile = convertWorkspaceLocation(
			"untitled:external",
			{ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			workspaceRoot,
		);
		expect(outside.kind).toBe("skip");
		expect(nonFile.kind).toBe("skip");
	});
});
