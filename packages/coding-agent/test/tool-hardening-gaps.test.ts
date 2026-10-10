import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@myharness/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/session/manager/index.ts";
import { createGrepTool } from "../src/tools/files/grep.ts";
import { createLsTool } from "../src/tools/files/ls.ts";
import { wrapToolWithResultPersistence } from "../src/tools/tool-result-persistence.ts";
import { GREP_MAX_LINE_LENGTH } from "../src/tools/truncate.ts";

/**
 * Gap coverage for the T03 tool hardening (gaps B4-B6 and the `literal` half of item 6 in
 * `data/overnight-2026-10-10/tests-2a/gaps.md`). `tool-hardening.test.ts` proves the fixes
 * themselves; this file adds the branch that keeps a failure honest (persistence cannot write),
 * the third grep truncation trigger (overlong match lines), the remaining `ls` limit shapes
 * (fraction and NaN) and the explicit `literal` switch.
 */

const cleanupDirs: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function createSessionDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "tool-hardening-gaps-"));
	cleanupDirs.push(dir);
	return dir;
}

function textOf(result: AgentToolResult<any>): string {
	return result.content
		.filter((part: any) => part.type === "text")
		.map((part: any) => part.text)
		.join("\n");
}

describe("tool hardening gaps", () => {
	it("keeps the bounded preview and no durable reference when the full output cannot be persisted", async () => {
		const sessionDir = await createSessionDir();
		const sessionManager = SessionManager.create(process.cwd(), sessionDir);
		// `tool-results` is a regular file, so every attempt to create the sidecar directory
		// fails (ENOTDIR) and the persistence step is guaranteed to throw.
		await writeFile(join(sessionDir, "tool-results"), "not a directory", "utf8");

		const tool: AgentTool<any> = {
			name: "unpersistable",
			label: "unpersistable",
			description: "test",
			parameters: {} as any,
			execute: async (): Promise<AgentToolResult<any>> => ({
				content: [{ type: "text", text: `head line\n${"tail line\n".repeat(6_000)}` }],
				details: {},
			}),
		};

		const result = await wrapToolWithResultPersistence(tool, sessionManager).execute(
			"call-b4",
			{},
			undefined,
			undefined,
		);
		const text = textOf(result);

		// A failure must never look like a saved reference: the model keeps a bounded preview
		// plus an explicit diagnostic, and gets no path to a file that does not exist.
		expect(text).toContain("完整输出保存失败");
		expect(text).not.toContain("完整输出已保存");
		expect(result.details?.fullOutputPath).toBeUndefined();
		expect(text.length).toBeLessThan(60 * 1024);
		expect(result.content.some((part: any) => part.type === "text")).toBe(true);
	});

	it("persists the uncut match lines when an overlong grep line is truncated", async () => {
		const testDir = await createSessionDir();
		const marker = "NEEDLE";
		const longLine = `${marker}${"".padEnd(GREP_MAX_LINE_LENGTH + 500, "x")}`;
		await writeFile(join(testDir, "long-lines.txt"), `${longLine}\nshort ${marker} line\n`, "utf8");

		const sessionManager = SessionManager.create(testDir, join(testDir, "sessions"));
		const grepTool = wrapToolWithResultPersistence(createGrepTool(testDir), sessionManager);

		const result = await grepTool.execute("call-b5", { pattern: marker, path: testDir });
		const preview = textOf(result);

		// The preview shows the cut; the persisted sidecar keeps the whole line, which is the
		// only way the model can still see what fell past GREP_MAX_LINE_LENGTH.
		expect(preview).toContain(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars`);
		const fullOutputPath = result.details?.fullOutputPath as string | undefined;
		expect(fullOutputPath).toBeDefined();
		const fullText = await readFile(fullOutputPath!, "utf8");
		expect(fullText).toContain(longLine);
		expect(fullText.length).toBeGreaterThan(preview.length);
	});

	it("matches a dash-leading pattern literally when literal is requested", async () => {
		const testDir = await createSessionDir();
		await writeFile(join(testDir, "flags.txt"), "-foo|bar\nplain text\n", "utf8");

		const grepTool = createGrepTool(testDir);

		// `literal` is the only switch for fixed-string search, and it must still be safe for a
		// pattern that begins with a dash (the pattern travels as `-e <pattern> -- <path>`).
		const literal = await grepTool.execute("call-literal", { pattern: "-foo|bar", path: testDir, literal: true });
		const literalText = textOf(literal);
		expect(literalText).toContain("flags.txt:1: -foo|bar");
		expect(literalText).not.toContain("No matches found");

		// Regex semantics stay the default: the alternative also matches a bare "bar".
		await writeFile(join(testDir, "alternation.txt"), "bar\n", "utf8");
		const regex = await grepTool.execute("call-regex", {
			pattern: "-foo|bar",
			path: join(testDir, "alternation.txt"),
		});
		const regexText = textOf(regex);
		expect(regexText).toContain("alternation.txt:1: bar");
		expect(regexText).not.toContain("flags.txt");
	});

	it("clamps a fractional ls limit to at least one entry and falls back to the default for NaN", async () => {
		const testDir = await createSessionDir();
		await writeFile(join(testDir, "alpha.txt"), "a");
		await writeFile(join(testDir, "beta.txt"), "b");
		await mkdir(join(testDir, "gamma-dir"));

		const lsTool = createLsTool(testDir);

		// 0.5 floors to 0, which would silently drop every entry; resolveEntryLimit keeps >= 1.
		const fractional = await lsTool.execute("call-fractional", { path: testDir, limit: 0.5 });
		const fractionalText = textOf(fractional);
		expect(fractionalText.split("\n")[0]).toBe("alpha.txt");
		expect(fractional.details?.entryLimitReached).toBe(1);

		// NaN must not become "0 entries" nor "null entries": it falls back to the default cap.
		const invalid = await lsTool.execute("call-nan", { path: testDir, limit: Number.NaN });
		const invalidText = textOf(invalid);
		expect(invalidText).toContain("alpha.txt");
		expect(invalidText).toContain("beta.txt");
		expect(invalidText).toContain("gamma-dir/");
		expect(invalid.details?.entryLimitReached).toBeUndefined();
	});
});
