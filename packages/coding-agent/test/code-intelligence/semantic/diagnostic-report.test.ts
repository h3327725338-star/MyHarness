import { describe, expect, it } from "vitest";
import { readDiagnosticReport } from "../../../src/symbols/semantic/lsp-types.ts";

describe("standard pull diagnostic reports", () => {
	it("accepts versionless full and unchanged reports and preserves opaque resultIds", () => {
		expect(readDiagnosticReport({ kind: "full", items: [], resultId: "opaque" })).toMatchObject({
			kind: "full",
			version: undefined,
			resultId: "opaque",
		});
		expect(readDiagnosticReport({ kind: "unchanged", resultId: "next" })).toMatchObject({
			kind: "unchanged",
			resultId: "next",
		});
	});
	it("retains related full and unchanged documents", () => {
		const relatedDocuments = {
			"file:///a.ts": { kind: "full", items: [], resultId: "a" },
			"file:///b.ts": { kind: "unchanged", resultId: "b" },
		};
		expect(readDiagnosticReport({ kind: "full", items: [], relatedDocuments })?.relatedDocuments).toMatchObject(
			relatedDocuments,
		);
	});
	it.each([
		{ kind: "unchanged" },
		{ kind: "full", items: [], relatedDocuments: [] },
		{ kind: "full", items: [], relatedDocuments: { "file:///a.ts": { kind: "unchanged" } } },
		{
			kind: "full",
			items: [],
			relatedDocuments: { "file:///a.ts": { kind: "full", items: [], relatedDocuments: {} } },
		},
	])("rejects malformed or recursively nested reports: %j", (raw) => {
		expect(readDiagnosticReport(raw)).toBeUndefined();
	});
});
