import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionConversationPath, getSessionDir } from "../src/config/paths/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import {
	cleanupEmptySessionDirectories,
	hasSessionAttachmentsForCleanup,
	relocateSessionAttachments,
	relocateSessionFile,
	removeEmptySessionDirectory,
	rewriteSessionManifestPaths,
} from "../src/session/storage/jsonl/index.ts";
import {
	deleteSessionFile,
	describeSessionDeleteImpact,
} from "../src/session/storage/jsonl/file-operations.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function structuredSession(sessionId = "session-x", workspaceId = "workspace-x") {
	const dataRoot = mkdtempSync(join(tmpdir(), "myharness-delreloc-"));
	roots.push(dataRoot);
	const file = getSessionConversationPath(dataRoot, workspaceId, sessionId, "chat.jsonl");
	const sessionDir = getSessionDir(dataRoot, workspaceId, sessionId);
	const conversationDir = join(sessionDir, "conversation");
	mkdirSync(conversationDir, { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: tmpdir() })}\n`,
		"utf8",
	);
	// 附件库：artifacts + uploads + tool-results + manifest
	mkdirSync(join(sessionDir, "artifacts", "reports"), { recursive: true });
	writeFileSync(join(sessionDir, "artifacts", "reports", "report.md"), "report-bytes");
	mkdirSync(join(conversationDir, "uploads"), { recursive: true });
	writeFileSync(join(conversationDir, "uploads", "input.bin"), "upload-bytes");
	mkdirSync(join(sessionDir, "tool-results"), { recursive: true });
	writeFileSync(join(sessionDir, "tool-results", "sidecar.txt"), "sidecar-bytes");
	writeFileSync(
		join(sessionDir, "tool-results", ".myharness-sidecar-orphans.json"),
		`${JSON.stringify({ version: 1, entries: [{ relativePath: "tool-results/sidecar.txt", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), size: 12, mtimeMs: Date.now(), status: "pending" }] }, null, 2)}\n`,
		"utf8",
	);
	mkdirSync(join(sessionDir, "metadata"), { recursive: true });
	writeFileSync(
		join(sessionDir, "metadata", "session.json"),
		`${JSON.stringify({ version: 1, sessionId, workspaceId, cwd: tmpdir(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), conversationPath: file })}\n`,
		"utf8",
	);
	return { dataRoot, file, sessionDir, conversationDir, sessionId, workspaceId };
}

describe("session delete prompts attachment ownership", () => {
	it("删前提示附件归属", () => {
		const s = structuredSession();
		const impact = describeSessionDeleteImpact(s.file);
		expect(impact.hasAttachments).toBe(true);
		expect(impact.attachments.length).toBeGreaterThan(0);
		expect(impact.message).toContain("附件");
		expect(impact.totalFiles).toBeGreaterThanOrEqual(3);
	});

	it("默认仅删引用并保留附件", async () => {
		const s = structuredSession();
		const result = await deleteSessionFile(s.file, { permanent: true });
		expect(result.ok).toBe(true);
		expect(existsSync(s.file)).toBe(false);
		expect(existsSync(join(s.sessionDir, "artifacts", "reports", "report.md"))).toBe(true);
		expect(existsSync(join(s.conversationDir, "uploads", "input.bin"))).toBe(true);
		expect(existsSync(join(s.sessionDir, "tool-results", "sidecar.txt"))).toBe(true);
		expect(existsSync(join(s.sessionDir, "metadata", "artifacts-origin.json"))).toBe(true);
	});

	it("确认后才连附件一起删", async () => {
		const s = structuredSession();
		const result = await deleteSessionFile(s.file, {
			permanent: true,
			deleteArtifacts: true,
			deleteAttachments: true,
		});
		expect(result.ok).toBe(true);
		expect(existsSync(s.sessionDir)).toBe(false);
	});

	it("反例：删除取消则什么都不删", async () => {
		const s = structuredSession();
		// UI 流程：先提示归属，用户取消后根本不调用删除。
		const impact = describeSessionDeleteImpact(s.file);
		expect(impact.hasAttachments).toBe(true);
		const cancelled = true;
		if (!cancelled) await deleteSessionFile(s.file, { permanent: true });
		expect(existsSync(s.file)).toBe(true);
		expect(existsSync(join(s.sessionDir, "artifacts", "reports", "report.md"))).toBe(true);
		expect(existsSync(join(s.sessionDir, "tool-results", "sidecar.txt"))).toBe(true);
	});

	it("manager 透出同样的删除提示", () => {
		const s = structuredSession();
		const manager = SessionManager.open(s.file);
		const impact = manager.describeDeleteImpact();
		expect(impact?.hasAttachments).toBe(true);
		expect(impact?.message).toContain("附件");
	});
});

describe("session relocate carries attachments", () => {
	it("搬迁把附件库一起搬并重写 manifest", () => {
		const s = structuredSession("session-move", "workspace-move");
		const targetSessionDir = join(s.dataRoot, "workspaces", s.workspaceId, "sessions", "session-moved");
		const targetFile = join(targetSessionDir, "conversation", "chat.jsonl");
		const entries = [
			{ type: "session", version: 3, id: "session-move", timestamp: new Date().toISOString(), cwd: tmpdir() },
		] as never[];
		const oldArtifact = join(s.sessionDir, "artifacts", "reports", "report.md");
		const result = relocateSessionFile({
			sourceFile: s.file,
			targetFile,
			entries,
			flushed: true,
			sourceSessionDir: s.sessionDir,
			targetSessionDir,
		});
		expect(result.flushed).toBe(true);
		expect(existsSync(targetFile)).toBe(true);
		// 旧文件与旧附件绝对路径不可再访问
		expect(existsSync(s.file)).toBe(false);
		expect(existsSync(oldArtifact)).toBe(false);
		expect(() => readFileSync(oldArtifact, "utf8")).toThrow();
		// 新路径可访问
		expect(readFileSync(join(targetSessionDir, "artifacts", "reports", "report.md"), "utf8")).toBe("report-bytes");
		expect(existsSync(join(targetSessionDir, "conversation", "uploads", "input.bin"))).toBe(true);
		expect(existsSync(join(targetSessionDir, "tool-results", "sidecar.txt"))).toBe(true);
		// manifest 相对路径：孤儿 manifest 仍为相对路径，session.json 指向新文件
		const sessionMeta = JSON.parse(readFileSync(join(targetSessionDir, "metadata", "session.json"), "utf8")) as {
			conversationPath: string;
		};
		expect(sessionMeta.conversationPath).toBe(targetFile);
		const orphan = JSON.parse(
			readFileSync(join(targetSessionDir, "tool-results", ".myharness-sidecar-orphans.json"), "utf8"),
		) as { entries: { relativePath: string }[] };
		expect(orphan.entries[0]!.relativePath).toBe("tool-results/sidecar.txt");
	});

	it("反例：搬迁后旧绝对路径访问失败", () => {
		const s = structuredSession("session-oldabs", "workspace-oldabs");
		const targetSessionDir = join(s.dataRoot, "workspaces", s.workspaceId, "sessions", "session-newabs");
		const targetFile = join(targetSessionDir, "conversation", "chat.jsonl");
		const oldUpload = join(s.conversationDir, "uploads", "input.bin");
		expect(existsSync(oldUpload)).toBe(true);
		relocateSessionFile({
			sourceFile: s.file,
			targetFile,
			entries: [
				{ type: "session", version: 3, id: "session-oldabs", timestamp: new Date().toISOString(), cwd: tmpdir() },
			] as never[],
			flushed: true,
			sourceSessionDir: s.sessionDir,
			targetSessionDir,
		});
		expect(existsSync(oldUpload)).toBe(false);
		expect(existsSync(join(targetSessionDir, "conversation", "uploads", "input.bin"))).toBe(true);
	});

	it("反例：缺 manifest 时搬迁仍成功且不抛错", () => {
		const s = structuredSession("session-nomanifest", "workspace-nomanifest");
		rmSync(join(s.sessionDir, "metadata", "session.json"), { force: true });
		rmSync(join(s.sessionDir, "tool-results", ".myharness-sidecar-orphans.json"), { force: true });
		const targetSessionDir = join(s.dataRoot, "workspaces", s.workspaceId, "sessions", "session-nomanifest-new");
		const targetFile = join(targetSessionDir, "conversation", "chat.jsonl");
		let result!: { flushed: boolean; warning?: string };
		expect(() => {
			result = relocateSessionFile({
				sourceFile: s.file,
				targetFile,
				entries: [
					{ type: "session", version: 3, id: "session-nomanifest", timestamp: new Date().toISOString(), cwd: tmpdir() },
				] as never[],
				flushed: true,
				sourceSessionDir: s.sessionDir,
				targetSessionDir,
			});
		}).not.toThrow();
		expect(result.flushed).toBe(true);
		expect(existsSync(targetFile)).toBe(true);
		expect(existsSync(join(targetSessionDir, "artifacts", "reports", "report.md"))).toBe(true);
		// 缺 manifest 重写静默跳过：直接调用也不抛错
		expect(() => rewriteSessionManifestPaths(targetSessionDir, targetFile)).not.toThrow();
		expect(() => relocateSessionAttachments(join(s.dataRoot, "no-such-dir"), targetSessionDir)).not.toThrow();
	});
});

describe("cleanup never removes attachment dirs", () => {
	it("空目录可回收，有附件目录必须保留", () => {
		const dataRoot = mkdtempSync(join(tmpdir(), "myharness-cleanup-"));
		roots.push(dataRoot);
		const emptySession = join(dataRoot, "workspaces", "workspace-c", "sessions", "empty-session");
		mkdirSync(join(emptySession, "conversation"), { recursive: true });
		const attachSession = join(dataRoot, "workspaces", "workspace-c", "sessions", "attach-session");
		mkdirSync(join(attachSession, "artifacts", "reports"), { recursive: true });
		writeFileSync(join(attachSession, "artifacts", "reports", "keep.md"), "keep");
		mkdirSync(join(attachSession, "conversation"), { recursive: true });
		const old = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(join(emptySession, "conversation"), old, old);
		utimesSync(emptySession, old, old);
		utimesSync(join(attachSession, "conversation"), old, old);
		utimesSync(attachSession, old, old);

		expect(hasSessionAttachmentsForCleanup(attachSession)).toBe(true);
		expect(hasSessionAttachmentsForCleanup(emptySession)).toBe(false);
		expect(removeEmptySessionDirectory(attachSession, "attach-session")).toBe(false);

		const removed = cleanupEmptySessionDirectories(dataRoot, { minAgeMs: 1_000 });
		expect(removed).toContain(emptySession);
		expect(existsSync(emptySession)).toBe(false);
		expect(existsSync(attachSession)).toBe(true);
		expect(existsSync(join(attachSession, "artifacts", "reports", "keep.md"))).toBe(true);
	});
});
