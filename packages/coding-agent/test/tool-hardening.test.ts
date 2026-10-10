import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@myharness/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountConnections } from "../src/providers/credentials/account-connections.ts";
import { InMemoryAuthStorageBackend } from "../src/providers/credentials/auth-storage.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { createGrepTool } from "../src/tools/files/grep.ts";
import { createLsTool } from "../src/tools/files/ls.ts";
import { createGitHubTool } from "../src/tools/github/tool.ts";
import { wrapToolWithResultPersistence } from "../src/tools/tool-result-persistence.ts";
import { cutAtCharBoundary, truncateLine } from "../src/tools/truncate.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

describe("tool-hardening", () => {
	// Item 2: 工具结果多段文字被合并丢内容
	describe("item 2: tool-result-persistence preserves multiple text blocks alongside images", () => {
		it("retains all text blocks and image blocks in order without collapsing them into one", async () => {
			const sessionDir = await mkdtemp(join(tmpdir(), "tool-hardening-item2-"));
			cleanupDirs.push(sessionDir);
			const sessionManager = SessionManager.create(process.cwd(), sessionDir);

			const multiBlockTool: AgentTool<any> = {
				name: "multi-block",
				label: "multi-block",
				description: "test",
				parameters: {} as any,
				execute: async (): Promise<AgentToolResult<any>> => ({
					content: [
						{ type: "text", text: "caption 1" },
						{ type: "image", data: "image-data-1", mimeType: "image/png" },
						{ type: "text", text: `caption 2 intro\n${"extra line\n".repeat(2500)}` },
						{ type: "image", data: "image-data-2", mimeType: "image/png" },
					],
					details: {},
				}),
			};

			const wrapped = wrapToolWithResultPersistence(multiBlockTool, sessionManager);
			const result = await wrapped.execute("call-item2", {}, undefined, undefined);

			// Before fix: replaceTextContent collapsed all text parts into a single text block,
			// leaving content with length 3: [ { type: "text" }, img1, img2 ].
			// After fix: content retains all 4 blocks in their original positions.
			expect(result.content.length).toBe(4);
			expect(result.content[0]).toEqual({ type: "text", text: "caption 1" });
			expect(result.content[1]).toEqual({ type: "image", data: "image-data-1", mimeType: "image/png" });
			expect(result.content[2].type).toBe("text");
			expect((result.content[2] as { text: string }).text).toContain("caption 2 intro");
			expect((result.content[2] as { text: string }).text).toContain("完整输出已保存");
			expect(result.content[3]).toEqual({ type: "image", data: "image-data-2", mimeType: "image/png" });
		});
	});

	// Item 3: 截断把 emoji 切成乱码
	describe("item 3: cutAtCharBoundary and truncateLine avoid splitting surrogate pairs", () => {
		it("does not split UTF-16 surrogate pairs (emoji) when truncating by character count", () => {
			const emojiText = "😀".repeat(10); // 10 emojis = 20 UTF-16 code units

			// Before fix: text.slice(0, 5) ended on high surrogate \uD83D (0xD83D), creating dangling surrogate.
			// After fix: cutAtCharBoundary drops the incomplete high surrogate, keeping 4 code units (2 emojis).
			const cut5 = cutAtCharBoundary(emojiText, 5);
			expect(cut5).toBe("😀😀");
			expect(cut5.length).toBe(4);

			const truncatedLine = truncateLine(emojiText, 5);
			expect(truncatedLine.wasTruncated).toBe(true);
			expect(truncatedLine.text).toBe("😀😀... [truncated]");

			// Confirm no dangling high surrogate remains in the output text
			const hasDanglingSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(truncatedLine.text);
			expect(hasDanglingSurrogate).toBe(false);
		});
	});

	// Item 4: ls 和 github 工具截断后内容找不回
	describe("item 4: ls and github persist full output via FULL_TEXT_OUTPUT when truncated", () => {
		it("ls persists complete directory listing to file when entry limit is reached", async () => {
			const testDir = await mkdtemp(join(tmpdir(), "tool-hardening-ls-persist-"));
			cleanupDirs.push(testDir);
			for (let i = 1; i <= 5; i++) {
				await writeFile(join(testDir, `file_${i}.txt`), `content ${i}`);
			}

			const sessionManager = SessionManager.create(testDir, join(testDir, "sessions"));
			const lsTool = wrapToolWithResultPersistence(createLsTool(testDir), sessionManager);

			// Call with limit = 2 (total 5 files)
			const result = await lsTool.execute("call-ls-persist", { path: testDir, limit: 2 });

			// Before fix: ls did not attach FULL_TEXT_OUTPUT, so result.details.fullOutputPath was undefined.
			// After fix: fullOutputPath is set, result text has the reference, and saved file has all 5 files.
			expect(result.details?.fullOutputPath).toBeDefined();
			const fullOutputPath = result.details.fullOutputPath as string;
			const previewText = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(previewText).toContain(`[完整输出已保存：${fullOutputPath}]`);

			const fullText = await readFile(fullOutputPath, "utf8");
			expect(fullText).toContain("file_1.txt");
			expect(fullText).toContain("file_5.txt");
		});

		it("github persists complete JSON output to file when API result exceeds limit", async () => {
			const testDir = await mkdtemp(join(tmpdir(), "tool-hardening-gh-persist-"));
			cleanupDirs.push(testDir);
			const sessionManager = SessionManager.create(testDir, join(testDir, "sessions"));

			const storage = new InMemoryAuthStorageBackend();
			storage.withLock(() => ({
				result: undefined,
				next: JSON.stringify({
					github: {
						account: { login: "octocat", id: 1 },
						token: "dummy-token",
						clientId: "app",
						scopes: ["repo"],
					},
				}),
			}));

			// Large response exceeding 50KB limit
			const largeRepoList = Array.from({ length: 600 }, (_, i) => ({
				id: i,
				name: `repo-${i}`,
				description: "a".repeat(100),
			}));
			const request = vi.fn().mockResolvedValue(Response.json(largeRepoList));
			const connections = new AccountConnections(storage, request as any);

			const ghTool = wrapToolWithResultPersistence(createGitHubTool(testDir, { connections }), sessionManager);
			const result = await ghTool.execute("call-gh-persist", { path: "/user/repos" });

			// Before fix: github tool did not attach FULL_TEXT_OUTPUT, so fullOutputPath was undefined.
			// After fix: fullOutputPath is set and the persisted file contains the complete JSON.
			expect(result.details?.fullOutputPath).toBeDefined();
			const fullOutputPath = result.details.fullOutputPath as string;
			const previewText = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(previewText).toContain(`[完整输出已保存：${fullOutputPath}]`);

			const fullText = await readFile(fullOutputPath, "utf8");
			expect(fullText).toContain('"name": "repo-599"');
		});
	});

	// Item 5: ls 的 limit 没有下限钳制
	describe("item 5: ls limit clamps non-positive values to at least 1", () => {
		it("clamps limit 0 and negative limits to 1 entry instead of returning empty results", async () => {
			const testDir = await mkdtemp(join(tmpdir(), "tool-hardening-ls-limit-"));
			cleanupDirs.push(testDir);
			await writeFile(join(testDir, "alpha.txt"), "a");
			await writeFile(join(testDir, "beta.txt"), "b");

			const lsTool = createLsTool(testDir);

			// limit = 0
			// Before fix: loop stopped immediately, returning 0 entries.
			// After fix: limit is clamped to 1, returning alpha.txt.
			const res0 = await lsTool.execute("call-limit-0", { path: testDir, limit: 0 });
			const text0 = res0.content[0]?.type === "text" ? res0.content[0].text : "";
			expect(text0.split("\n")[0]).toBe("alpha.txt");
			expect(res0.details?.entryLimitReached).toBe(1);

			// limit = -5
			// Before fix: returning 0 entries.
			// After fix: limit is clamped to 1.
			const resNeg = await lsTool.execute("call-limit-neg", { path: testDir, limit: -5 });
			const textNeg = resNeg.content[0]?.type === "text" ? resNeg.content[0].text : "";
			expect(textNeg.split("\n")[0]).toBe("alpha.txt");
			expect(resNeg.details?.entryLimitReached).toBe(1);
		});
	});

	// Item 6: grep 以 - 开头的模式保持正则语义
	describe("item 6: grep preserves regex semantics for patterns starting with dash", () => {
		it("matches regex alternatives when pattern starts with dash like '-foo|bar'", async () => {
			const testDir = await mkdtemp(join(tmpdir(), "tool-hardening-grep-dash-"));
			cleanupDirs.push(testDir);
			await writeFile(join(testDir, "target.txt"), "first line\nbar\nlast line\n");

			const grepTool = createGrepTool(testDir);

			// Pattern starts with '-': '-foo|bar'
			// Before fix: pattern.startsWith("-") caused "--fixed-strings" to be passed,
			// searching for literal string "-foo|bar", failing to match "bar".
			// After fix: pattern is passed as regex via '-e', successfully matching "bar".
			const result = await grepTool.execute("call-grep-dash", {
				pattern: "-foo|bar",
				path: testDir,
			});
			const output = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(output).toContain("target.txt:2: bar");
			expect(output).not.toContain("No matches found");
		});
	});

	// Item 7: ls 逐条串行 stat 改为有限并发并保持顺序不变
	describe("item 7: ls concurrent stat maintains alphabetical output order", () => {
		it("batches stat calls while preserving alphabetical order and directory indicators", async () => {
			const testDir = await mkdtemp(join(tmpdir(), "tool-hardening-ls-concurrency-"));
			cleanupDirs.push(testDir);

			for (let i = 0; i < 40; i++) {
				const name = `item_${String(i).padStart(3, "0")}`;
				if (i % 2 === 0) {
					await mkdir(join(testDir, name));
				} else {
					await writeFile(join(testDir, name), `content ${i}`);
				}
			}

			const lsTool = createLsTool(testDir);
			const result = await lsTool.execute("call-ls-concurrency", { path: testDir, limit: 100 });
			const output = result.content[0]?.type === "text" ? result.content[0].text : "";
			const lines = output.split("\n");

			expect(lines.length).toBe(40);
			for (let i = 0; i < 40; i++) {
				const expected = `item_${String(i).padStart(3, "0")}${i % 2 === 0 ? "/" : ""}`;
				expect(lines[i]).toBe(expected);
			}
		});
	});
});
