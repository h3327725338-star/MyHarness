import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile } from "../src/session/storage/jsonl/index.ts";
import type { SessionHeader, SessionJsonlDiagnostics } from "../src/session/types.ts";

describe("Session JSONL recovery diagnostics", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function createSessionFile(content: string): string {
		const root = mkdtempSync(join(tmpdir(), "myharness-session-jsonl-diagnostics-"));
		roots.push(root);
		const filePath = join(root, "session.jsonl");
		writeFileSync(filePath, content, "utf8");
		return filePath;
	}

	function header(): SessionHeader {
		return {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-09-18T00:00:00.000Z",
			cwd: "C:\\workspace",
		};
	}

	it("recovers a truncated final line and reports its exact line", () => {
		const filePath = createSessionFile(
			`${JSON.stringify(header())}\n{"type":"message","id":"m1"}\n{"type":"message"`,
		);
		const diagnostics: SessionJsonlDiagnostics = { recovered: false, issues: [] };
		const entries = loadEntriesFromFile(filePath, diagnostics);

		expect(entries).toHaveLength(2);
		expect(diagnostics).toMatchObject({ recovered: true });
		expect(diagnostics.issues).toEqual([expect.objectContaining({ line: 3, kind: "truncated_tail" })]);
	});

	it("distinguishes a malformed middle line from a recoverable tail", () => {
		const filePath = createSessionFile(
			[JSON.stringify(header()), "not-json", JSON.stringify({ type: "custom", id: "c1" })].join("\n"),
		);
		const diagnostics: SessionJsonlDiagnostics = { recovered: false, issues: [] };
		const entries = loadEntriesFromFile(filePath, diagnostics);

		expect(entries).toHaveLength(2);
		expect(diagnostics.issues).toEqual([expect.objectContaining({ line: 2, kind: "malformed_line" })]);
	});

	it("reports a schema-invalid JSON value without destroying the file", () => {
		const filePath = createSessionFile(`${JSON.stringify(header())}\n[1,2]\n`);
		const diagnostics: SessionJsonlDiagnostics = { recovered: false, issues: [] };
		const entries = loadEntriesFromFile(filePath, diagnostics);

		expect(entries).toHaveLength(1);
		expect(diagnostics.issues).toEqual([expect.objectContaining({ line: 2, kind: "schema_invalid" })]);
	});
});
