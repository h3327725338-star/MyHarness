import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionConversationPath, getSessionDir, parseSessionDataPath } from "../src/config/paths/index.ts";
import { ensureSessionArtifacts } from "../src/session/artifacts/store.ts";
import { getMemoryPaths, withMemoryLock, writeMemoryFile } from "../src/session/memory/store.ts";
import { deleteSessionFile } from "../src/session/storage/jsonl/file-operations.ts";

/** Lets a test make chosen renames and writes of the deletion fail; everything else reaches the real file system. */
const faults = vi.hoisted(() => ({
	rename: undefined as ((from: string, to: string) => string | undefined) | undefined,
	writeFile: undefined as ((file: string) => string | undefined) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const fail = (code: string | undefined) => {
		if (!code) return;
		throw Object.assign(new Error(`${code}: injected`), { code });
	};
	return {
		...actual,
		rename: async (from: string, to: string) => {
			fail(faults.rename?.(String(from), String(to)));
			return actual.rename(from, to);
		},
		writeFile: async (file: string, ...rest: unknown[]) => {
			fail(faults.writeFile?.(String(file)));
			return (actual.writeFile as (...args: unknown[]) => Promise<void>)(file, ...rest);
		},
	};
});

const roots: string[] = [];
const holders: ChildProcess[] = [];
afterEach(() => {
	faults.rename = undefined;
	faults.writeFile = undefined;
	for (const holder of holders.splice(0)) holder.kill();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function chat(workspaceId = "w", sessionId = "s") {
	const dataRoot = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-delete-atomic-"));
	roots.push(dataRoot);
	const file = getSessionConversationPath(dataRoot, workspaceId, sessionId, "chat.jsonl");
	const sessionDir = getSessionDir(dataRoot, workspaceId, sessionId);
	mkdirSync(join(sessionDir, "conversation"), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: tmpdir() })}\n`,
	);
	return { dataRoot, file, sessionDir, memory: getMemoryPaths({ dataRoot, workspaceId, sessionId }) };
}

const memory = (id: string, extra = "") => {
	const scope = id.slice(0, id.indexOf("/"));
	return `---\nid: ${id}\nname: ${id.slice(scope.length + 1)}\ndescription: d\ntype: project\nscope: ${scope}\n${extra}---\n\nbody\n`;
};

const trashEntries = (dataRoot: string) =>
	existsSync(join(dataRoot, "trash")) ? readdirSync(join(dataRoot, "trash")) : [];

/** Hold a file open the way Word does (no delete sharing) from a hidden PowerShell until the test ends. */
async function holdOpen(file: string): Promise<ChildProcess> {
	const holder = spawn(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-WindowStyle",
			"Hidden",
			"-Command",
			`$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','None'); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); Start-Sleep -Seconds 60; $f.Close()`,
		],
		{ windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	holders.push(holder);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("file holder did not start")), 20_000);
		holder.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("ready")) {
				clearTimeout(timer);
				resolve();
			}
		});
		holder.on("exit", () => reject(new Error("file holder exited early")));
	});
	return holder;
}

async function release(holder: ChildProcess): Promise<void> {
	const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
	holder.kill();
	await exited;
}

describe("chat deletion is all-or-nothing", () => {
	it.skipIf(process.platform !== "win32")(
		"deletes nothing while a file that goes is open in another program, then everything once it is closed",
		async () => {
			const c = chat();
			const report = join(ensureSessionArtifacts(parseSessionDataPath(c.file)!), "reports", "report.docx");
			writeFileSync(report, "docx");
			const note = join(c.memory.sessionDir, "note.md");
			await writeMemoryFile(note, memory("session/note"));
			const owned = join(c.memory.globalDir, "owned.md");
			await writeMemoryFile(owned, memory("global/owned", "sourceSessionId: s\nupdatedBy: s\n"));
			const holder = await holdOpen(report);
			const options = { permanent: true, deleteArtifacts: true, deleteMemory: true };
			const refused = await deleteSessionFile(c.file, options);
			expect(refused).toMatchObject({ ok: false, code: "in-use" });
			for (const file of [c.file, report, note, owned]) expect(existsSync(file)).toBe(true);
			expect(trashEntries(c.dataRoot)).toEqual([]);
			await release(holder);
			expect(await deleteSessionFile(c.file, options)).toEqual({ ok: true, method: "unlink" });
			for (const file of [c.sessionDir, owned]) expect(existsSync(file)).toBe(false);
			expect(trashEntries(c.dataRoot)).toEqual([]);
		},
		60_000,
	);

	it.skipIf(process.platform !== "win32")(
		"puts the parts that already moved back when a later one is open (kept uploads stay where they are)",
		async () => {
			const c = chat();
			const upload = join(c.sessionDir, "conversation", "uploads", "id-1", "attachment-a.txt");
			mkdirSync(join(upload, ".."), { recursive: true });
			writeFileSync(upload, "a");
			const report = join(ensureSessionArtifacts(parseSessionDataPath(c.file)!), "reports", "report.docx");
			writeFileSync(report, "docx");
			mkdirSync(join(c.sessionDir, "metadata"), { recursive: true });
			writeFileSync(join(c.sessionDir, "metadata", "session.json"), "{}");
			const holder = await holdOpen(report);
			const refused = await deleteSessionFile(c.file, { permanent: true, deleteArtifacts: true });
			expect(refused).toMatchObject({ ok: false, code: "in-use" });
			for (const file of [c.file, upload, report, join(c.sessionDir, "metadata", "session.json")])
				expect(existsSync(file)).toBe(true);
			expect(trashEntries(c.dataRoot)).toEqual([]);
			await release(holder);
			expect((await deleteSessionFile(c.file, { permanent: true, deleteArtifacts: true })).ok).toBe(true);
			expect(readdirSync(c.sessionDir)).toEqual(["conversation"]);
			expect(existsSync(upload)).toBe(true);
		},
		60_000,
	);

	it.skipIf(process.platform !== "win32")(
		"deletes the chat while a kept artifact stays open",
		async () => {
			const c = chat();
			const report = join(ensureSessionArtifacts(parseSessionDataPath(c.file)!), "reports", "report.docx");
			writeFileSync(report, "docx");
			await holdOpen(report);
			expect((await deleteSessionFile(c.file, { permanent: true })).ok).toBe(true);
			expect(existsSync(c.file)).toBe(false);
			expect(existsSync(report)).toBe(true);
			expect(existsSync(join(c.sessionDir, "metadata", "artifacts-origin.json"))).toBe(true);
		},
		60_000,
	);

	it("changes nothing when the memory lock cannot be taken", async () => {
		const c = chat();
		const note = join(c.memory.sessionDir, "note.md");
		await writeMemoryFile(note, memory("session/note"));
		let refused: Awaited<ReturnType<typeof deleteSessionFile>> | undefined;
		await withMemoryLock(c.dataRoot, async () => {
			refused = await deleteSessionFile(c.file, { permanent: true, deleteMemory: true });
		});
		expect(refused?.ok).toBe(false);
		expect(refused?.code).toBe("memory-busy");
		for (const file of [c.file, note]) expect(existsSync(file)).toBe(true);
		expect(trashEntries(c.dataRoot)).toEqual([]);
	});

	it("keeps memories without leaving an empty conversation folder", async () => {
		const c = chat();
		writeFileSync(`${c.file}.pinned`, "pinned\n");
		await writeMemoryFile(join(c.memory.sessionDir, "note.md"), memory("session/note"));
		expect((await deleteSessionFile(c.file, { permanent: true })).ok).toBe(true);
		expect(readdirSync(c.sessionDir)).toEqual(["memory"]);
		expect(existsSync(join(c.memory.sessionDir, "note.md"))).toBe(true);
		expect(trashEntries(c.dataRoot)).toEqual([]);
	});

	it("does not keep an empty artifacts scaffold or a memory folder holding only the maintenance log", async () => {
		const c = chat();
		ensureSessionArtifacts(parseSessionDataPath(c.file)!);
		mkdirSync(c.memory.sessionDir, { recursive: true });
		writeFileSync(join(c.memory.sessionDir, "maintenance.log"), "{}\n");
		writeFileSync(join(c.memory.sessionDir, "maintenance.json"), "{}");
		mkdirSync(join(c.sessionDir, "metadata"), { recursive: true });
		writeFileSync(join(c.sessionDir, "metadata", "session.json"), "{}");
		expect((await deleteSessionFile(c.file, { permanent: true })).ok).toBe(true);
		expect(existsSync(c.sessionDir)).toBe(false);
		expect(trashEntries(c.dataRoot)).toEqual([]);
	});

	it("keeps uploads in the chat's attachment library and next to the conversation", async () => {
		const c = chat();
		const library = join(c.sessionDir, "uploads", "id-1");
		mkdirSync(library, { recursive: true });
		writeFileSync(join(library, "attachment-a.txt"), "a");
		writeFileSync(join(library, "manifest.json"), "{}");
		mkdirSync(join(c.sessionDir, "conversation", "uploads", "id-2"), { recursive: true });
		writeFileSync(join(c.sessionDir, "conversation", "uploads", "id-2", "attachment-b.txt"), "b");
		expect((await deleteSessionFile(c.file, { permanent: true, deleteArtifacts: true, deleteMemory: true })).ok).toBe(
			true,
		);
		expect(existsSync(c.file)).toBe(false);
		expect(existsSync(join(library, "attachment-a.txt"))).toBe(true);
		expect(readdirSync(join(c.sessionDir, "conversation"))).toEqual(["uploads"]);
	});

	/** A chat whose deletion moves part by part: conversation, artifacts and metadata go; a tool result stays. */
	function partedChat() {
		const c = chat();
		const report = join(ensureSessionArtifacts(parseSessionDataPath(c.file)!), "reports", "report.docx");
		writeFileSync(report, "docx");
		mkdirSync(join(c.sessionDir, "metadata"), { recursive: true });
		writeFileSync(join(c.sessionDir, "metadata", "session.json"), "{}");
		mkdirSync(join(c.sessionDir, "tool-results"), { recursive: true });
		writeFileSync(join(c.sessionDir, "tool-results", "r1.txt"), "kept");
		// metadata will not move (in use), and artifacts, already moved, will not go back.
		faults.rename = (from, to) =>
			from === join(c.sessionDir, "metadata")
				? "EBUSY"
				: to === join(c.sessionDir, "artifacts") && basename(dirname(from)).startsWith("w-s-")
					? "EPERM"
					: undefined;
		return { ...c, report };
	}

	it("puts back every part it can when one will not go back, and keeps the rest in a marked tombstone", async () => {
		const c = partedChat();
		const result = await deleteSessionFile(c.file, { permanent: true, deleteArtifacts: true });
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Could not put back artifacts") });
		// The conversation moved first and is put back even though artifacts, moved after it, could not be.
		for (const file of [c.file, join(c.sessionDir, "metadata", "session.json")]) expect(existsSync(file)).toBe(true);
		const [tombstone] = trashEntries(c.dataRoot);
		const kept = join(c.dataRoot, "trash", tombstone!);
		expect(existsSync(join(kept, "artifacts", "reports", "report.docx"))).toBe(true);
		const marker = JSON.parse(readFileSync(join(kept, "RESTORE-FAILED.json"), "utf8"));
		expect(marker).toEqual({
			sessionDir: c.sessionDir,
			notRestored: [{ path: "artifacts", error: "EPERM: injected" }],
		});
	}, 20_000);

	it("keeps the tombstone of a failed put-back even when its marker cannot be written", async () => {
		const c = partedChat();
		faults.writeFile = (file) => (basename(file) === "RESTORE-FAILED.json" ? "ENOSPC" : undefined);
		expect((await deleteSessionFile(c.file, { permanent: true, deleteArtifacts: true })).ok).toBe(false);
		expect(existsSync(c.file)).toBe(true);
		const [tombstone] = trashEntries(c.dataRoot);
		expect(existsSync(join(c.dataRoot, "trash", tombstone!, "artifacts", "reports", "report.docx"))).toBe(true);
	}, 20_000);

	it("sweeps tombstones that an earlier deletion could not remove, but not recent or unrestored ones", async () => {
		const c = chat();
		const trash = join(c.dataRoot, "trash");
		for (const name of ["w-old-1000", `w-recent-${Date.now()}`, "w-unrestored-2000"])
			mkdirSync(join(trash, name, "conversation"), { recursive: true });
		writeFileSync(join(trash, "w-unrestored-2000", "RESTORE-FAILED.json"), "{}");
		expect((await deleteSessionFile(c.file, { permanent: true })).ok).toBe(true);
		expect(trashEntries(c.dataRoot).sort()).toEqual([expect.stringMatching(/^w-recent-/), "w-unrestored-2000"]);
	});
});
