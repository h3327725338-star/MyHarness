import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { AutoMemoryManager } from "../src/agent/runtime/auto-memory.ts";
import { getSessionConversationPath, getSessionDir, parseSessionDataPath } from "../src/config/paths/index.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { readMemoryWriteCreations } from "../src/session/memory/provenance.ts";
import {
	archiveMemoryFile,
	claimPendingMemory,
	deleteMemoryPermanently,
	deleteSessionMemories,
	describeSessionMemories,
	getMemoryPaths,
	listMemoryFiles,
	migrateLegacyMemories,
	refreshMemoryIndexes,
	restoreMemoryArchive,
	withMemoryLock,
	writeMemoryFile,
} from "../src/session/memory/store.ts";
import { deleteSessionFile, summarizeSessionDeletion } from "../src/session/storage/jsonl/file-operations.ts";
import { flushAllWorkspaceIndexes } from "../src/session/storage/jsonl/sessions-index.ts";
import { flushSessionWrites } from "../src/session/storage/jsonl/write-batch.ts";
import type { SessionEntry } from "../src/session/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "memory-storage-"));
	roots.push(root);
	return { root, dataRoot: join(root, "data"), agentDir: join(root, "agent") };
}
function memory(scope: string, name: string, body = "shared-key original") {
	return `---\nid: ${scope}/${name}\nname: ${name}\ndescription: shared-key\ntype: feedback\nscope: ${scope}\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n${body}\n`;
}
const settingsManager = SettingsManager.inMemory({ autoMemory: { enabled: true, provider: "test", model: "memory" } });

describe("hierarchical memory storage", () => {
	it("finds old relevant memories beyond the former 200-entry cutoff", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		await writeMemoryFile(
			join(p.globalDir, "old.md"),
			memory("global", "important", "rare-anchor confirmed convention"),
		);
		for (let i = 0; i < 205; i++) {
			await writeMemoryFile(
				join(p.globalDir, `new-${i}.md`),
				memory("global", `new-${i}`, `unrelated ${i}`).replaceAll("2026-01-01", "2026-02-01"),
			);
		}
		const manager = new AutoMemoryManager({
			...f,
			cwd: f.root,
			workspaceId: "a",
			sessionId: "one",
			persisted: true,
			settingsManager,
		});
		try {
			expect((await manager.recall("rare-anchor"))?.content).toContain("confirmed convention");
			expect((await manager.recall("rare-anchor"))?.content).toContain("confirmed convention");
			// 新口径：目录每轮常驻；没有任何词面匹配时仍注入目录，但不带正文卡片。
			const fallback = await manager.recall("no-matching-topic");
			expect(fallback).toBeDefined();
			expect(String(fallback?.content)).toContain("记忆目录");
			expect((fallback?.details as { ids: string[] }).ids).toEqual([]);
		} finally {
			manager.dispose();
		}
	});
	it("shares global/workspace memory, isolates conversations, and excludes archives", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		await writeMemoryFile(join(p.globalDir, "global.md"), memory("global", "global"));
		await writeMemoryFile(join(p.workspaceDir, "workspace.md"), memory("workspace", "workspace"));
		await writeMemoryFile(join(p.sessionDir, "session.md"), memory("session", "session"));
		const retired = join(p.workspaceDir, "retired.md");
		await writeMemoryFile(retired, memory("workspace", "retired"));
		await archiveMemoryFile(retired, "consolidated");
		rmSync(retired);
		const manager = (workspaceId: string, sessionId: string) =>
			new AutoMemoryManager({ ...f, cwd: f.root, workspaceId, sessionId, persisted: true, settingsManager });
		const own = await manager("a", "one").recall("shared-key");
		expect(own?.content).toContain("## session");
		expect(own?.content).not.toContain("## retired");
		const sibling = await manager("a", "two").recall("shared-key");
		expect(sibling?.content).toContain("## workspace");
		expect(sibling?.content).not.toContain("## session");
		const other = await manager("b", "one").recall("shared-key");
		expect(other?.content).toContain("## global");
		expect(other?.content).not.toContain("## workspace");
		await refreshMemoryIndexes(f.dataRoot);
		expect(listMemoryFiles(f.dataRoot)).toHaveLength(4);
	});

	it("archives updates and restores without destroying either historical version", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		const target = join(p.sessionDir, "note.md");
		await writeMemoryFile(target, memory("session", "note", "old text"));
		const runner = async () =>
			JSON.stringify({
				operations: [
					{
						action: "upsert",
						scope: "session",
						type: "feedback",
						id: "session/note",
						name: "note",
						description: "note",
						content: "new text",
					},
				],
			});
		const manager = new AutoMemoryManager({
			...f,
			cwd: f.root,
			workspaceId: "a",
			sessionId: "one",
			persisted: true,
			settingsManager,
			modelRunner: runner,
		});
		const entries = [
			{ type: "message", id: "user-one", message: { role: "user", content: [{ type: "text", text: "remember" }] } },
		] as unknown as SessionEntry[];
		expect(await manager.runExtraction(entries)).toBe(true);
		expect(readFileSync(target, "utf8")).toContain("new text");
		const archive = listMemoryFiles(f.dataRoot).find((entry) => entry.archived)!;
		expect(archive.content).toContain("old text");
		await restoreMemoryArchive(f.dataRoot, archive.path);
		expect(readFileSync(target, "utf8")).toContain("old text");
		expect(listMemoryFiles(f.dataRoot).filter((entry) => entry.archived)).toHaveLength(2);
		await expect(restoreMemoryArchive(f.dataRoot, "../secret.md")).rejects.toThrow();
	});

	it("retains conversation memories even when chat and artifacts are permanently removed", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		await writeMemoryFile(join(p.sessionDir, "note.md"), memory("session", "note"));
		const file = getSessionConversationPath(f.dataRoot, "a", "one", "chat.jsonl");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "chat");
		expect((await deleteSessionFile(file, { permanent: true, deleteArtifacts: true })).ok).toBe(true);
		expect(existsSync(file)).toBe(false);
		expect(listMemoryFiles(f.dataRoot)[0]?.sessionId).toBe("one");
	});

	it("copies legacy global and matched workspace data once, retaining unmatched data and originals", async () => {
		const f = fixture();
		const project = join(f.root, "project");
		const normalized = process.platform === "win32" ? project.toLowerCase() : project;
		const key = createHash("sha256").update(normalized).digest("hex").slice(0, 20);
		const metadata = join(f.dataRoot, "workspaces", "a", "metadata", "workspace.json");
		mkdirSync(dirname(metadata), { recursive: true });
		writeFileSync(metadata, JSON.stringify({ workspace: { rootPath: project } }));
		const legacy = join(f.agentDir, "memory");
		await writeMemoryFile(join(legacy, "global", "pref.md"), memory("global", "pref"));
		await writeMemoryFile(join(legacy, "projects", key, "matched.md"), memory("project", "matched"));
		await writeMemoryFile(join(legacy, "projects", "unknown", "pending.md"), memory("project", "pending"));
		await migrateLegacyMemories(f.dataRoot, f.agentDir);
		await migrateLegacyMemories(f.dataRoot, f.agentDir);
		const entries = listMemoryFiles(f.dataRoot);
		expect(entries).toHaveLength(3);
		expect(entries.find((entry) => entry.name === "matched")?.workspaceId).toBe("a");
		expect(entries.find((entry) => entry.name === "pending")?.scope).toBe("pending");
		expect(existsSync(join(legacy, "global", "pref.md"))).toBe(true);
	});

	it("archives consolidated entries instead of permanently deleting them", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		const target = join(p.workspaceDir, "note.md");
		await writeMemoryFile(target, memory("workspace", "note"));
		await writeMemoryFile(
			p.statePath,
			JSON.stringify({ version: 1, sessions: {}, consolidation: { a: { sessionIds: ["s1", "s2", "s3", "s4"] } } }),
		);
		const manager = new AutoMemoryManager({
			...f,
			cwd: f.root,
			workspaceId: "a",
			sessionId: "one",
			persisted: true,
			settingsManager,
			modelRunner: async ({ systemPrompt }) =>
				systemPrompt.includes("Review existing memories")
					? JSON.stringify({ operations: [{ action: "delete", id: "workspace/note" }] })
					: '{"operations":[]}',
		});
		const entries = [
			{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "remember" }] } },
		] as unknown as SessionEntry[];
		expect(await manager.runExtraction(entries)).toBe(true);
		expect(existsSync(target)).toBe(false);
		expect(listMemoryFiles(f.dataRoot).find((entry) => entry.archived)?.content).toContain("original");
	});

	it("keeps independent data roots and duplicate workspace matches isolated", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		await writeMemoryFile(join(p.globalDir, "note.md"), memory("global", "note"));
		const other = new AutoMemoryManager({
			...f,
			dataRoot: join(f.root, "other-data"),
			cwd: f.root,
			workspaceId: "a",
			sessionId: "one",
			persisted: true,
			settingsManager,
		});
		expect(await other.recall("shared-key")).toBeUndefined();
		const project = join(f.root, "project");
		const key = createHash("sha256")
			.update(process.platform === "win32" ? project.toLowerCase() : project)
			.digest("hex")
			.slice(0, 20);
		for (const id of ["a", "b"]) {
			const file = join(f.dataRoot, "workspaces", id, "metadata", "workspace.json");
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify({ workspace: { rootPath: project } }));
		}
		await writeMemoryFile(join(f.agentDir, "memory", "projects", key, "note.md"), memory("project", "note"));
		await migrateLegacyMemories(f.dataRoot, f.agentDir);
		expect(listMemoryFiles(f.dataRoot).filter((entry) => entry.scope === "pending")).toHaveLength(1);
		expect(listMemoryFiles(f.dataRoot).filter((entry) => entry.scope === "workspace")).toHaveLength(0);
	});

	it("rejects junctions before writing outside the data tree", async () => {
		const f = fixture();
		const outside = join(f.root, "outside");
		mkdirSync(outside);
		mkdirSync(f.dataRoot);
		symlinkSync(outside, join(f.dataRoot, "memory"), process.platform === "win32" ? "junction" : "dir");
		await expect(writeMemoryFile(join(f.dataRoot, "memory", "note.md"), "unsafe")).rejects.toThrow();
		expect(existsSync(join(outside, "note.md"))).toBe(false);
	});
});

describe("permanent memory deletion and pending claims", () => {
	it("purges a memory with all its archives and refreshes the indexes", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		const target = join(p.workspaceDir, "note.md");
		await writeMemoryFile(target, memory("workspace", "note"));
		await archiveMemoryFile(target, "test");
		await archiveMemoryFile(target, "test-again");
		await refreshMemoryIndexes(f.dataRoot);
		expect(listMemoryFiles(f.dataRoot)).toHaveLength(3);

		const { archiveCount } = await deleteMemoryPermanently(f.dataRoot, "workspaces/a/memory/note.md");
		expect(archiveCount).toBe(2);
		expect(existsSync(target)).toBe(false);
		expect(listMemoryFiles(f.dataRoot)).toHaveLength(0);
		const index = JSON.parse(readFileSync(join(f.dataRoot, "memory", "index.json"), "utf8")) as {
			entries: unknown[];
		};
		expect(index.entries).toHaveLength(0);

		await expect(deleteMemoryPermanently(f.dataRoot, "workspaces/a/memory/note.md")).rejects.toThrow();
		await expect(deleteMemoryPermanently(f.dataRoot, "../outside.md")).rejects.toThrow();
	});

	it("refuses to delete archived copies directly", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		const target = join(p.workspaceDir, "note.md");
		await writeMemoryFile(target, memory("workspace", "note"));
		const archive = await archiveMemoryFile(target, "test");
		const archiveName = archive.split(/[\\/]/).pop() ?? "";
		const relativeArchive = `workspaces/a/memory/archive/${archiveName}`;
		await expect(deleteMemoryPermanently(f.dataRoot, relativeArchive)).rejects.toThrow();
		expect(existsSync(archive)).toBe(true);
	});

	it("claims a pending memory into a registered workspace", async () => {
		const f = fixture();
		const metadata = join(f.dataRoot, "workspaces", "a", "metadata", "workspace.json");
		mkdirSync(dirname(metadata), { recursive: true });
		writeFileSync(metadata, JSON.stringify({ workspace: { rootPath: join(f.root, "project") } }));
		const pendingDir = join(f.dataRoot, "memory", "pending", "source-key");
		await writeMemoryFile(join(pendingDir, "legacy.md"), memory("pending", "legacy"));
		await expect(claimPendingMemory(f.dataRoot, "memory/pending/source-key/legacy.md", "ghost")).rejects.toThrow();
		const { id } = await claimPendingMemory(f.dataRoot, "memory/pending/source-key/legacy.md", "a");
		expect(id.startsWith("workspace/")).toBe(true);
		expect(existsSync(join(pendingDir, "legacy.md"))).toBe(false);
		const claimed = listMemoryFiles(f.dataRoot).find((entry) => entry.id === id);
		expect(claimed?.scope).toBe("workspace");
		expect(claimed?.workspaceId).toBe("a");

		await expect(claimPendingMemory(f.dataRoot, "memory/pending/source-key/legacy.md", "a")).rejects.toThrow();
	});

	it("deletes a chat's memory folder only when explicitly asked", async () => {
		for (const deleteMemory of [false, true]) {
			const f = fixture();
			const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
			await writeMemoryFile(join(p.sessionDir, "note.md"), memory("session", "note"));
			const file = getSessionConversationPath(f.dataRoot, "a", "one", "chat.jsonl");
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "chat");
			expect((await deleteSessionFile(file, { permanent: true, deleteMemory })).ok).toBe(true);
			expect(existsSync(join(p.sessionDir, "note.md"))).toBe(!deleteMemory);
			expect(listMemoryFiles(f.dataRoot)).toHaveLength(deleteMemory ? 0 : 1);
		}
	});
});

describe("deleting a chat's memories", () => {
	/** One memory version with exactly the given frontmatter fields (undefined ones are left out). */
	function version(id: string, fields: Record<string, string | undefined>, body = `${id} body`) {
		const scope = id.slice(0, id.indexOf("/"));
		const frontmatter = Object.fromEntries(
			Object.entries({
				id,
				name: id.slice(scope.length + 1),
				description: "d",
				type: "project",
				scope,
				...fields,
			}).filter(([, value]) => value !== undefined),
		);
		return `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${body}\n`;
	}
	/** Write the versions oldest first; every earlier one ends up in archive/ the way an update archives it. */
	async function history(directory: string, id: string, versions: Array<Record<string, string | undefined>>) {
		const file = join(directory, `${id.slice(id.indexOf("/") + 1)}.md`);
		for (const [index, fields] of versions.entries()) {
			if (index > 0) await archiveMemoryFile(file, "updated");
			await writeMemoryFile(file, version(id, fields, `${id} v${index}`));
		}
		return file;
	}
	const toolResult = (timestamp: string, text: string, ids: string[]) =>
		JSON.stringify({
			type: "message",
			id: `entry-${Math.random().toString(36).slice(2)}`,
			parentId: null,
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "memory_write",
				content: [{ type: "text", text }],
				details: { mode: "write", total: ids.length, returned: ids.length, ids },
				isError: false,
				timestamp: Date.parse(timestamp),
			},
		});

	it("reads only the memories this chat itself created with memory_write", async () => {
		const f = fixture();
		const file = getSessionConversationPath(f.dataRoot, "a", "one", "chat.jsonl");
		mkdirSync(dirname(file), { recursive: true });
		const header = "2026-05-01T10:00:00.000Z";
		writeFileSync(
			file,
			[
				JSON.stringify({ type: "session", version: 3, id: "one", timestamp: header, cwd: f.root }),
				// Copied from the parent chat by a fork: older than this chat.
				toolResult("2026-04-01T10:00:00.000Z", "已记住：global/inherited（global · project）。", [
					"global/inherited",
				]),
				toolResult(
					"2026-05-01T10:01:00.000Z",
					"已记住：global/tool-made（global · project）。\n已更新：workspace/edited（旧版已归档）。\n已创建用户画像：global/用户画像。",
					["global/tool-made", "workspace/edited", "global/用户画像"],
				),
				JSON.stringify({
					type: "message",
					id: "u",
					parentId: null,
					timestamp: header,
					message: { role: "user", content: "已记住：global/fake（" },
				}),
			].join("\n"),
		);
		const created = await readMemoryWriteCreations(file);
		expect([...created.keys()]).toEqual(["global/tool-made"]);
		expect(created.get("global/tool-made")).toEqual({
			entryIds: [expect.stringMatching(/^entry-/)],
			chatStartedAt: Date.parse(header),
			lastResultAt: Date.parse("2026-05-01T10:01:00.000Z"),
		});
		expect((await readMemoryWriteCreations(join(f.root, "missing.jsonl"))).size).toBe(0);
	});

	it("removes the chat's own and solely owned memories and keeps every memory another writer touched", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		const one = { sourceSessionId: "one", sourceWorkspaceId: "a" };
		await writeMemoryFile(join(p.sessionDir, "note.md"), memory("session", "note"));
		// Extracted twice by this chat (legacy without updatedBy, then new style): owned, with its archive.
		const owned = await history(p.globalDir, "global/owned", [
			{ ...one, sourceEntryId: "e0" },
			{ ...one, sourceEntryId: "e1", updatedBy: "one" },
		]);
		expect(listMemoryFiles(f.dataRoot).filter((entry) => entry.archived && entry.id === "global/owned")).toHaveLength(
			1,
		);
		// Another memory whose file name starts like the owned one: its history is not touched.
		const sibling = await history(p.globalDir, "global/owned-2", [
			{ sourceSessionId: "two", sourceEntryId: "x0", updatedBy: "two" },
			{ sourceSessionId: "two", sourceEntryId: "x1", updatedBy: "two" },
		]);
		const legacyOwn = await history(p.workspaceDir, "workspace/legacy-own", [{ ...one, sourceEntryId: "e2" }]);
		// Extracted later by another chat: the source moved to that chat.
		const laterOther = await history(p.globalDir, "global/later-other", [
			{ ...one, sourceEntryId: "e3" },
			{ sourceSessionId: "two", sourceEntryId: "x3", updatedBy: "two" },
		]);
		// Consolidated: legacy (the consolidation version keeps the previous source fields) and new style.
		const consolidated = await history(p.globalDir, "global/consolidated", [
			{ ...one, sourceEntryId: "e4" },
			{ ...one, sourceEntryId: "e4" },
		]);
		const consolidatedNew = await history(p.workspaceDir, "workspace/consolidated-new", [
			{ ...one, sourceEntryId: "e5", updatedBy: "one" },
			{ ...one, sourceEntryId: "e5", updatedBy: "consolidation" },
		]);
		// Edited with memory_write from another chat.
		const edited = await history(p.workspaceDir, "workspace/edited", [
			{ ...one, sourceEntryId: "e6", updatedBy: "one" },
			{ ...one, sourceEntryId: "e6", updatedBy: "two" },
		]);
		const restored = await history(p.globalDir, "global/restored", [
			{ ...one, sourceEntryId: "e7", updatedBy: "restore" },
		]);
		const profile = await history(p.globalDir, "global/用户画像", [
			{ ...one, sourceEntryId: "e8", updatedBy: "one" },
		]);
		// Old memory_write and old consolidation wrote no provenance fields at all; this chat started at 10:00 and its
		// memory_write results (createdByTool below) were saved at 10:01.
		const inCreation = { updatedAt: "2026-05-01T10:00:59.500Z" };
		// Created with memory_write in this chat before the provenance fields existed.
		const toolMade = await history(p.globalDir, "global/tool-made", [inCreation]);
		// A legacy memory_write memory this chat only updated.
		const toolUpdated = await history(p.globalDir, "global/tool-updated", [inCreation]);
		// Created here, then rewritten without fields (old consolidation, or another chat's old memory_write edit).
		const toolRewritten = await history(p.globalDir, "global/tool-rewritten", [
			inCreation,
			{ updatedAt: "2026-05-02T09:00:00.000Z" },
		]);
		// This chat's memory of that name is gone; another chat's old memory_write later made a new one with that slug.
		const toolReused = await history(p.globalDir, "global/tool-reused", [{ updatedAt: "2026-05-03T09:00:00.000Z" }]);
		// A version with no time stamp cannot be placed in this chat's creation.
		const toolUndated = await history(p.globalDir, "global/tool-undated", [{}]);
		// A retired history (consolidated away) that is entirely this chat's.
		const retired = await history(p.globalDir, "global/retired", [{ ...one, sourceEntryId: "e9", updatedBy: "one" }]);
		await archiveMemoryFile(retired, "consolidated");
		rmSync(retired);
		// A session memory consolidation retired: only its archived text is left in the chat's folder.
		const retiredNote = join(p.sessionDir, "old.md");
		await writeMemoryFile(retiredNote, memory("session", "old"));
		await archiveMemoryFile(retiredNote, "consolidated");
		rmSync(retiredNote);
		const pending = join(f.dataRoot, "memory", "pending", "key", "legacy.md");
		await writeMemoryFile(pending, version("pending/legacy", one));
		await writeMemoryFile(
			p.statePath,
			JSON.stringify({
				version: 1,
				sessions: {
					one: { updatedAt: "2026-01-01T00:00:00.000Z" },
					two: { updatedAt: "2026-01-01T00:00:00.000Z" },
				},
				consolidation: { a: { sessionIds: ["one", "two"], pendingChanges: 2 } },
			}),
		);
		await refreshMemoryIndexes(f.dataRoot);
		const creation = (entryId: string) => ({
			entryIds: [entryId],
			chatStartedAt: Date.parse("2026-05-01T10:00:00.000Z"),
			lastResultAt: Date.parse("2026-05-01T10:01:00.000Z"),
		});
		const provenance = {
			createdByTool: new Map([
				["global/tool-made", creation("c1")],
				["global/tool-rewritten", creation("c2")],
				["global/tool-reused", creation("c3")],
				["global/tool-undated", creation("c4")],
			]),
		};
		const location = { workspaceId: "a", sessionId: "one" };

		const impact = await describeSessionMemories(f.dataRoot, location, provenance);
		expect(impact.owned.map((entry) => `${entry.scope}:${entry.id}`).sort()).toEqual([
			"global:global/owned",
			"global:global/tool-made",
			"session:session/note",
			"workspace:workspace/legacy-own",
		]);
		expect(impact.owned.find((entry) => entry.id === "global/owned")?.path).toBe("memory/owned.md");
		expect(impact.shared).toBe(7);
		// The retired session note and the retired global history go too.
		expect(impact.retired).toBe(2);

		await withMemoryLock(f.dataRoot, () => deleteSessionMemories(f.dataRoot, location, provenance));
		for (const gone of [owned, legacyOwn, toolMade, p.sessionDir]) expect(existsSync(gone)).toBe(false);
		for (const kept of [
			sibling,
			laterOther,
			consolidated,
			consolidatedNew,
			edited,
			restored,
			profile,
			toolUpdated,
			toolRewritten,
			toolReused,
			toolUndated,
			pending,
		])
			expect(existsSync(kept)).toBe(true);
		const remaining = listMemoryFiles(f.dataRoot);
		expect(remaining.filter((entry) => entry.id === "global/owned")).toEqual([]);
		expect(remaining.filter((entry) => entry.id === "global/retired")).toEqual([]);
		expect(remaining.filter((entry) => entry.id === "global/owned-2" && entry.archived)).toHaveLength(1);
		expect(remaining.filter((entry) => entry.id === "global/later-other" && entry.archived)).toHaveLength(1);
		const index = JSON.parse(readFileSync(join(f.dataRoot, "memory", "index.json"), "utf8")) as {
			entries: Array<{ id: string }>;
		};
		expect(index.entries.map((entry) => entry.id)).not.toContain("global/owned");
		expect(index.entries.map((entry) => entry.id)).toContain("global/later-other");
		const state = JSON.parse(readFileSync(p.statePath, "utf8"));
		expect(Object.keys(state.sessions)).toEqual(["two"]);
		expect(state.consolidation.a).toEqual({ sessionIds: ["two"], pendingChanges: 2 });
	});

	it("deletes a chat's memory_write creation through deleteSessionFile and keeps shared memories", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		const file = getSessionConversationPath(f.dataRoot, "a", "one", "chat.jsonl");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "one",
					timestamp: "2026-05-01T10:00:00.000Z",
					cwd: f.root,
				}),
				toolResult("2026-05-01T10:01:00.000Z", "已记住：workspace/tool-made（workspace · project）。", [
					"workspace/tool-made",
				]),
			].join("\n"),
		);
		const toolMade = await history(p.workspaceDir, "workspace/tool-made", [
			{ updatedAt: "2026-05-01T10:00:59.000Z" },
		]);
		const shared = await history(p.workspaceDir, "workspace/shared", [
			{ sourceSessionId: "one", sourceEntryId: "e1", updatedBy: "one" },
			{ sourceSessionId: "one", sourceEntryId: "e1", updatedBy: "consolidation" },
		]);
		await writeMemoryFile(join(p.sessionDir, "note.md"), memory("session", "note"));
		expect((await deleteSessionFile(file, { permanent: true, deleteMemory: true })).ok).toBe(true);
		expect(existsSync(toolMade)).toBe(false);
		expect(existsSync(shared)).toBe(true);
		expect(existsSync(dirname(dirname(file)))).toBe(false);
		expect(listMemoryFiles(f.dataRoot).map((entry) => entry.id)).toEqual(["workspace/shared", "workspace/shared"]);
	});

	it("keeps the memories whose making a fork or worktree copy of the chat still holds", async () => {
		const f = fixture();
		const storage = { dataRoot: f.dataRoot };
		const main = join(f.root, "main");
		const worktree = join(f.root, "worktree");
		mkdirSync(main, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const turn = (manager: SessionManager, text: string) => {
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			return manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			});
		};
		const remember = (manager: SessionManager, id: string) =>
			manager.appendMessage({
				role: "toolResult",
				toolCallId: `call-${id}`,
				toolName: "memory_write",
				content: [{ type: "text", text: `已记住：${id}（global · project）。` }],
				details: { mode: "write", total: 1, returned: 1, ids: [id] },
				isError: false,
				timestamp: Date.now(),
			});
		const parent = SessionManager.create(main, undefined, undefined, storage);
		const forkPoint = turn(parent, "hello");
		remember(parent, "global/before-copy");
		const extractedFrom = turn(parent, "a fact worth keeping");
		const parentFile = parent.getSessionFile()!;
		flushSessionWrites(parentFile);
		// Enter a worktree with the history, then merge back: two copies, and the original chat stays in main.
		const inWorktree = SessionManager.create(worktree, undefined, undefined, storage);
		inWorktree.adoptHistoryFrom(SessionManager.open(parentFile));
		const mergedBack = SessionManager.create(main, undefined, undefined, storage);
		mergedBack.adoptHistoryFrom(SessionManager.open(inWorktree.getSessionFile()!));
		// The worktree chat is gone, so the merged-back copy's parent can no longer be followed back to this chat.
		rmSync(dirname(dirname(inWorktree.getSessionFile()!)), { recursive: true, force: true });
		remember(parent, "global/after-copy");
		flushSessionWrites(parentFile);
		// A fork taken before any memory was made holds none of them.
		expect(SessionManager.open(parentFile).createBranchedSession(forkPoint)).toBeTruthy();
		// The main workspace is listed once, so its sessions index answers for its chats; the rest are opened.
		await SessionManager.list(main, undefined, undefined, storage);
		flushAllWorkspaceIndexes();

		const scope = parseSessionDataPath(parentFile)!;
		const sessionId = parent.getSessionId();
		const p = getMemoryPaths({ dataRoot: f.dataRoot, workspaceId: scope.workspaceId, sessionId });
		const mine = { sourceSessionId: sessionId, updatedBy: sessionId };
		const beforeCopy = await history(p.globalDir, "global/before-copy", [mine]);
		const extracted = await history(p.globalDir, "global/extracted", [{ ...mine, sourceEntryId: extractedFrom }]);
		const afterCopy = await history(p.globalDir, "global/after-copy", [mine]);
		expect((await summarizeSessionDeletion(parentFile)).memories).toEqual({
			owned: [{ id: "global/after-copy", name: "after-copy", scope: "global" }],
			shared: 2,
			retired: 0,
		});
		expect((await deleteSessionFile(parentFile, { permanent: true, deleteMemory: true })).ok).toBe(true);
		expect(existsSync(afterCopy)).toBe(false);
		for (const kept of [beforeCopy, extracted]) expect(existsSync(kept)).toBe(true);
		expect(existsSync(getSessionDir(f.dataRoot, scope.workspaceId, sessionId))).toBe(false);
	});

	it("reports archived memory text that only deleting the memories removes", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		const file = getSessionConversationPath(f.dataRoot, "a", "one", "chat.jsonl");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "one", timestamp: "2026-05-01T10:00:00.000Z", cwd: f.root })}\n`,
		);
		const note = join(p.sessionDir, "note.md");
		await writeMemoryFile(note, memory("session", "note"));
		await archiveMemoryFile(note, "consolidated");
		rmSync(note);
		const retired = await history(p.globalDir, "global/retired", [
			{ sourceSessionId: "one", sourceEntryId: "e1", updatedBy: "one" },
		]);
		await archiveMemoryFile(retired, "consolidated");
		rmSync(retired);
		expect((await summarizeSessionDeletion(file)).memories).toEqual({ owned: [], shared: 0, retired: 2 });
		expect((await deleteSessionFile(file, { permanent: true, deleteMemory: true })).ok).toBe(true);
		expect(listMemoryFiles(f.dataRoot)).toEqual([]);
	});

	it("marks a restored version as written by the restore, never by a chat", async () => {
		const f = fixture();
		const p = getMemoryPaths({ ...f, workspaceId: "a", sessionId: "one" });
		const file = await history(p.globalDir, "global/note", [{ updatedBy: "one" }, { updatedBy: "two" }]);
		const archive = listMemoryFiles(f.dataRoot).find((entry) => entry.archived)!;
		await restoreMemoryArchive(f.dataRoot, archive.path);
		expect(readFileSync(file, "utf8")).toContain("updatedBy: restore");
	});
});
