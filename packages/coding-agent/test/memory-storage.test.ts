import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutoMemoryManager } from "../src/agent/runtime/auto-memory.ts";
import { getSessionConversationPath } from "../src/config/paths/index.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import {
	archiveMemoryFile,
	getMemoryPaths,
	listMemoryFiles,
	migrateLegacyMemories,
	refreshMemoryIndexes,
	restoreMemoryArchive,
	writeMemoryFile,
} from "../src/session/memory/store.ts";
import { deleteSessionFile } from "../src/session/storage/jsonl/file-operations.ts";
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
			expect(await manager.recall("no-matching-topic")).toBeUndefined();
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
				systemPrompt.includes("审查现有记忆")
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
