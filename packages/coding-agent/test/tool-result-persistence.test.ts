import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@myharness/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/session/manager/index.ts";
import { createFindTool } from "../src/tools/files/find.ts";
import { createGrepTool } from "../src/tools/files/grep.ts";
import { createReadTool } from "../src/tools/files/read.ts";
import {
	cleanupOrphanedToolResults,
	FULL_TEXT_OUTPUT,
	persistToolText,
	wrapToolWithResultPersistence,
} from "../src/tools/tool-result-persistence.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("tool result persistence", () => {
	it("truncates generic large text, preserves it under the session tool-results directory, and keeps images", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "myharness-tool-results-test-"));
		cleanup.push(sessionDir);
		const sessionManager = SessionManager.create(process.cwd(), sessionDir);
		const tool: AgentTool<any> = {
			name: "large-extension",
			label: "large-extension",
			description: "test",
			parameters: {} as any,
			execute: async (): Promise<AgentToolResult<any>> => ({
				content: [
					{ type: "text", text: "x".repeat(70 * 1024) },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
				details: {},
			}),
		};

		const result = await wrapToolWithResultPersistence(tool, sessionManager).execute(
			"call-1",
			{},
			undefined,
			undefined,
		);
		const text = result.content.find((part) => part.type === "text");
		expect(text?.type === "text" ? text.text : "").toContain("完整输出已保存");
		expect(result.content.some((part) => part.type === "image")).toBe(true);
		const fullOutputPath = (result.details as { fullOutputPath: string }).fullOutputPath;
		expect(fullOutputPath).toContain(join("tool-results", sessionManager.getSessionId()));
		expect((await readFile(fullOutputPath, "utf8")).length).toBe(70 * 1024);
	});

	it("uses a built-in supplied original output instead of persisting only its preview", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "myharness-tool-results-test-"));
		cleanup.push(sessionDir);
		const sessionManager = SessionManager.create(process.cwd(), sessionDir);
		const full = "full\n".repeat(20_000);
		const tool: AgentTool<any> = {
			name: "read",
			label: "read",
			description: "test",
			parameters: {} as any,
			execute: async (): Promise<AgentToolResult<any>> => {
				const result = { content: [{ type: "text" as const, text: "preview" }], details: {} };
				Object.assign(result, { [FULL_TEXT_OUTPUT]: full });
				return result;
			},
		};

		const result = await wrapToolWithResultPersistence(tool, sessionManager).execute(
			"call-2",
			{},
			undefined,
			undefined,
		);
		const fullOutputPath = (result.details as { fullOutputPath: string }).fullOutputPath;
		expect(await readFile(fullOutputPath, "utf8")).toBe(full);
	});

	it("preserves Read, Grep, and Find content that exceeds their normal previews", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "myharness-tool-results-builtins-"));
		cleanup.push(projectDir);
		const sessionManager = SessionManager.create(projectDir, join(projectDir, "sessions"));
		await writeFile(join(projectDir, "large.txt"), `${"needle value\n".repeat(120)}${"x".repeat(60 * 1024)}`);

		const readResult = await wrapToolWithResultPersistence(createReadTool(projectDir), sessionManager).execute(
			"read-large",
			{ path: "large.txt" },
			undefined,
			undefined,
		);
		const readPath = (readResult.details as { fullOutputPath: string }).fullOutputPath;
		expect((await readFile(readPath, "utf8")).length).toBeGreaterThan(60 * 1024);

		const grepResult = await wrapToolWithResultPersistence(createGrepTool(projectDir), sessionManager).execute(
			"grep-many",
			{ pattern: "needle", path: "large.txt", limit: 2 },
			undefined,
			undefined,
		);
		const grepPath = (grepResult.details as { fullOutputPath: string }).fullOutputPath;
		expect((await readFile(grepPath, "utf8")).split("\n")).toHaveLength(120);

		const findResult = await wrapToolWithResultPersistence(
			createFindTool(projectDir, {
				operations: {
					exists: () => true,
					glob: () => Array.from({ length: 20 }, (_, index) => join(projectDir, `file-${index}.ts`)),
				},
			}),
			sessionManager,
		).execute("find-many", { pattern: "*.ts", limit: 2 }, undefined, undefined);
		const findPath = (findResult.details as { fullOutputPath: string }).fullOutputPath;
		expect((await readFile(findPath, "utf8")).split("\n")).toHaveLength(20);
	});

	it("keeps an unreferenced sidecar pending, then quarantines it idempotently", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "myharness-tool-results-recovery-"));
		cleanup.push(sessionDir);
		const sessionManager = SessionManager.create(process.cwd(), sessionDir, { id: "sidecar-recovery" });
		const sidecarPath = await persistToolText(sessionManager, "read", "call-recovery", "recoverable output");
		await mkdir(join(sessionDir, "conversation.jsonl.lock"));

		const locked = await cleanupOrphanedToolResults(sessionDir, {
			nowMs: Date.now() + 2_000,
			graceMs: 1_000,
		});
		expect(locked.pending).toContain(sidecarPath);
		expect(locked.quarantined).toHaveLength(0);
		expect(existsSync(sidecarPath)).toBe(true);
		await rm(join(sessionDir, "conversation.jsonl.lock"), { recursive: true, force: true });

		const first = await cleanupOrphanedToolResults(sessionDir, { nowMs: Date.now(), graceMs: 1_000 });
		expect(first.pending).toContain(sidecarPath);
		expect(first.quarantined).toHaveLength(0);
		expect(existsSync(sidecarPath)).toBe(true);

		const second = await cleanupOrphanedToolResults(sessionDir, {
			nowMs: Date.now() + 2_000,
			graceMs: 1_000,
		});
		expect(second.orphaned).toContain(sidecarPath);
		expect(second.quarantined).toHaveLength(1);
		expect(existsSync(sidecarPath)).toBe(false);
		expect(existsSync(second.quarantined[0]!)).toBe(true);

		const third = await cleanupOrphanedToolResults(sessionDir, {
			nowMs: Date.now() + 3_000,
			graceMs: 1_000,
		});
		expect(third.quarantined).toHaveLength(0);
		expect(third.errors).toEqual([]);
	});

	it("never quarantines a sidecar once its durable reference is present", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "myharness-tool-results-reference-"));
		cleanup.push(sessionDir);
		const sessionManager = SessionManager.create(process.cwd(), sessionDir, { id: "sidecar-reference" });
		const sidecarPath = await persistToolText(sessionManager, "read", "call-reference", "referenced output");
		await writeFile(
			join(sessionDir, "conversation.jsonl"),
			`${JSON.stringify({ fullOutputPath: sidecarPath })}\n`,
			"utf8",
		);

		const result = await cleanupOrphanedToolResults(sessionDir, {
			nowMs: Date.now() + 2_000,
			graceMs: 1_000,
		});
		expect(result.referenced).toContain(sidecarPath);
		expect(result.orphaned).toHaveLength(0);
		expect(result.quarantined).toHaveLength(0);
		expect(existsSync(sidecarPath)).toBe(true);
	});

	it("does not reclaim sidecars when a conversation file is malformed", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "myharness-tool-results-malformed-"));
		cleanup.push(sessionDir);
		const sessionManager = SessionManager.create(process.cwd(), sessionDir, { id: "sidecar-malformed" });
		const sidecarPath = await persistToolText(sessionManager, "read", "call-malformed", "uncertain output");
		await writeFile(join(sessionDir, "conversation.jsonl"), '{"incomplete":\n', "utf8");

		const result = await cleanupOrphanedToolResults(sessionDir, {
			nowMs: Date.now() + 2_000,
			graceMs: 1_000,
		});
		expect(result.quarantined).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(existsSync(sidecarPath)).toBe(true);
	});
});
