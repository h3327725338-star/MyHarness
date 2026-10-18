import { describe, expect, it, vi } from "vitest";
import type { SymbolsToolDetails, SymbolsToolInput } from "../src/tools/symbols.ts";
import { SymbolsOutputPages } from "../src/tools/symbols-output.ts";

const args: SymbolsToolInput = { operation: "file_symbols", path: "src/a.ts" };
const details: SymbolsToolDetails = {
	operation: "file_symbols",
	source: "semantic",
	completeness: "complete",
	status: "ok",
};
const header = "[source=semantic completeness=complete]\n";

describe("Symbols presentation bounds", () => {
	it("keeps a call edge and its sites together across pages", () => {
		const pages = new SymbolsOutputPages();
		const entries = Array.from(
			{ length: 8 },
			(_, index) =>
				`src/a.ts:${index + 1}:0 method sameName${index}\n  call_site src/caller.ts:${index + 10}:1-${index + 10}:3`,
		);
		let page = pages.create(args, header + entries.join("\n"), details, 1000);
		const text: string[] = [];
		while (true) {
			expect(page.text.length).toBeLessThanOrEqual(1000);
			const lines = page.text.split("\n").filter((line) => line.startsWith("src/") || line.includes("call_site"));
			for (let index = 0; index < lines.length; index += 2) {
				expect(lines[index]).toContain("sameName");
				expect(lines[index + 1]).toContain("call_site");
			}
			text.push(page.text);
			if (!page.details.nextCursor) break;
			page = pages.continue(args, page.details.nextCursor, 1000);
		}
		for (let index = 0; index < 8; index++)
			expect(text.join("\n").split(`method sameName${index}`).length - 1).toBe(1);
	});
	it("bounds repeated warning headers while retaining structured warnings", () => {
		const pages = new SymbolsOutputPages();
		const warnings = Array.from({ length: 100 }, (_, i) => `server${i}: ${"detail ".repeat(50)}`);
		const page = pages.create(
			args,
			`${header}${warnings.map((warning) => `[warning] ${warning}`).join("\n")}\nsrc/a.ts:1 function run`,
			{ ...details, warnings },
			1000,
		);
		expect(page.text.length).toBeLessThanOrEqual(1000);
		expect(page.text).toContain("structured details.warnings");
		expect(page.details.warnings).toEqual(warnings);
	});
	it("does not cut an oversized entry or leave an unusable infinite cursor", () => {
		const pages = new SymbolsOutputPages();
		const entry = `src/a.ts:1:0 function run ${"x".repeat(2000)} symbolId="opaque:0:0"`;
		const first = pages.create(args, header + entry, details, 1000);
		expect(first.text.length).toBeLessThanOrEqual(1000);
		expect(first.text).toContain("at src/a.ts:1:0");
		expect(first.details.nextCursor).toBeTypeOf("string");
		const rest = pages.continue(args, first.details.nextCursor!, 4000);
		expect(rest.text).toContain(entry);
		expect(rest.details.nextCursor).toBeUndefined();
		const impossible = pages.create(args, `${header}src/a.ts:1:0 ${"x".repeat(101000)}`, details, 1000);
		expect(impossible.text.length).toBeLessThanOrEqual(1000);
		expect(impossible.details).toMatchObject({ completeness: "partial", outputTruncated: true });
		expect(impossible.details.nextCursor).toBeUndefined();
	});
	it("evicts old snapshots and expires cursors", () => {
		const pages = new SymbolsOutputPages();
		const text = header + Array.from({ length: 50 }, (_, i) => `src/a.ts:${i + 1} function f${i}`).join("\n");
		const first = pages.create(args, text, details, 1000);
		for (let index = 0; index < 8; index++) pages.create(args, text, details, 1000);
		expect(() => pages.continue(args, first.details.nextCursor!, 1000)).toThrow(/expired/);
		const latest = pages.create(args, text, details, 1000);
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
		try {
			expect(() => pages.continue(args, latest.details.nextCursor!, 1000)).toThrow(/expired/);
		} finally {
			clock.mockRestore();
		}
	});
	it("never retains a single snapshot above the cache character budget", () => {
		const pages = new SymbolsOutputPages();
		const page = pages.create(
			args,
			header + `src/a.ts:1 function run ${"x".repeat(200)}\n`.repeat(40000),
			details,
			2000,
		);
		expect(page.text.length).toBeLessThanOrEqual(2000);
		expect(page.text).toContain("snapshot budget");
		expect(page.details.nextCursor).toBeUndefined();
		const small = pages.create(
			args,
			header + `src/a.ts:1 function run ${"x".repeat(200)}\n`.repeat(40000),
			details,
			1000,
		);
		expect(small.text.length).toBeLessThanOrEqual(1000);
		expect(small.details.nextCursor).toBeUndefined();
	});
});
