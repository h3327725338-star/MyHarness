import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWebPrefs, writeWebPrefs } from "../src/config/web-prefs.ts";
import { WorkspaceStore } from "../src/data/workspace-store.ts";
import { ModeStateStore } from "../src/session/mode-state.ts";
import { detectExternalSyncRisk, SyncEngine } from "../src/sync/engine.ts";
import { SyncService } from "../src/sync/service.ts";
import { SyncLocalStore } from "../src/sync/store.ts";
import type { DrivePort, RemoteFile, RemoteFolder } from "../src/sync/types.ts";
import { resolveCanonicalPath } from "../src/utils/paths.ts";

class FakeDrive implements DrivePort {
	readonly folders = new Map<string, Map<string, Uint8Array>>();
	readonly hiddenObjects = new Set<string>();
	batchReads = 0;

	constructor() {
		for (const name of ["root", "batches", "objects", "snapshots"]) this.folders.set(name, new Map());
	}

	list(folder: RemoteFolder): Promise<RemoteFile[]> {
		const entries = [...(this.folders.get(folder)?.entries() ?? [])]
			.filter(([name]) => !(folder === "objects" && this.hiddenObjects.has(name)))
			.map(([name, data]) => ({ id: `file-${name}`, name, size: data.byteLength }));
		return Promise.resolve(entries.sort((a, b) => a.name.localeCompare(b.name)));
	}

	read(folder: RemoteFolder, name: string): Promise<Uint8Array | undefined> {
		if (folder === "batches") this.batchReads += 1;
		if (folder === "objects" && this.hiddenObjects.has(name)) return Promise.resolve(undefined);
		return Promise.resolve(this.folders.get(folder)?.get(name));
	}

	write(folder: RemoteFolder, name: string, data: Uint8Array): Promise<RemoteFile> {
		this.folders.get(folder)!.set(name, data);
		return Promise.resolve({ id: `file-${name}`, name, size: data.byteLength });
	}

	uploadObject(hash: string, data: Uint8Array): Promise<void> {
		if (!this.folders.get("objects")!.has(hash)) this.folders.get("objects")!.set(hash, data);
		return Promise.resolve();
	}

	downloadObject(hash: string): Promise<Uint8Array | undefined> {
		return this.read("objects", hash);
	}

	ensureSpace(): Promise<{ folderId: string; folderName: string; syncId: string; url: string }> {
		if (!this.folders.get("root")!.has("identity.json")) {
			const identity = { version: 1, syncId: "space-1", createdAt: new Date(0).toISOString() };
			this.folders.get("root")!.set("identity.json", new TextEncoder().encode(JSON.stringify(identity)));
		}
		return Promise.resolve({
			folderId: "folder-1",
			folderName: "MyHarness",
			syncId: "space-1",
			url: "https://drive.google.com/drive/folders/folder-1",
		});
	}

	batchNames(): string[] {
		return [...this.folders.get("batches")!.keys()].sort();
	}

	reset(): void {
		for (const [name, map] of this.folders) if (name !== "root") map.clear();
	}
}

interface Device {
	root: string;
	agentDir: string;
	dataRoot: string;
	engine: SyncEngine;
	store: SyncLocalStore;
}

const roots: string[] = [];

function device(drive: FakeDrive, name: string, deviceId: string): Device {
	const root = mkdtempSync(join(tmpdir(), `myharness-sync-${name}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const dataRoot = join(root, "data");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataRoot, { recursive: true });
	const store = new SyncLocalStore(agentDir);
	const config = store.config();
	config.enabled = false;
	store.saveConfig(config);
	const engine = new SyncEngine({
		agentDir,
		dataRoot,
		deviceId,
		deviceName: name,
		store,
		accountKey: "account-1",
	});
	engine.setDrive(drive);
	return { root, agentDir, dataRoot, engine, store };
}

function writeWorkspace(root: string, workspaceId = "ws1", rootPath = join(root, "workspace-folders", "study")): void {
	const metadata = join(root, "workspaces", workspaceId, "metadata");
	mkdirSync(metadata, { recursive: true });
	writeFileSync(
		join(metadata, "workspace.json"),
		JSON.stringify({
			version: 2,
			workspace: {
				workspaceId,
				id: workspaceId,
				modes: ["general"],
				name: "Study",
				rootPath,
				createdAt: "2026-01-01T00:00:00.000Z",
				instructions: "Keep answers short.",
				memoryEnabled: true,
				libraryEnabled: true,
			},
		}),
	);
}

function writeSession(root: string, workspaceId = "ws1", sessionId = "s1"): string {
	writeWorkspace(root, workspaceId);
	const conversation = join(root, "workspaces", workspaceId, "sessions", sessionId, "conversation");
	mkdirSync(conversation, { recursive: true });
	const file = join(conversation, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		mode: "general",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: join(root, "workspace-folders", "study"),
		workspaceId,
	};
	const entry = {
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	};
	writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
	return file;
}

function appendEntry(file: string, entry: Record<string, unknown>): void {
	writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify(entry)}\n`);
}

function writeMemory(root: string, text: string): string {
	const memory = join(root, "memory");
	mkdirSync(memory, { recursive: true });
	const file = join(memory, "profile.md");
	writeFileSync(
		file,
		`---\nid: global/profile\nname: Profile\ndescription: shared\ntype: user\nscope: global\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n${text}\n`,
	);
	return file;
}

async function sync(...devices: Device[]): Promise<void> {
	for (const item of devices) await item.engine.runOnce();
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	delete process.env.MYHARNESS_DRIVE_ROOTS;
});

describe("Google Drive sync engine", () => {
	it("restores memories, General chats, workspace identity, artifacts, drafts and the prompt on a second device", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		writeMemory(a.dataRoot, "remember this");
		writeSession(a.dataRoot);
		mkdirSync(join(a.dataRoot, "workspaces", "ws1", "sessions", "s1", "artifacts"), { recursive: true });
		writeFileSync(
			join(a.dataRoot, "workspaces", "ws1", "sessions", "s1", "artifacts", "report.txt"),
			"artifact body",
		);
		const modeState = new ModeStateStore(a.agentDir);
		modeState.setPersonalPrompt("general", "Answer in Chinese.");
		modeState.setDraft("general", "s1", { text: "unfinished", attachments: [] });

		await a.engine.runOnce();
		await b.engine.runOnce();

		expect(existsSync(join(b.dataRoot, "memory", "profile.md"))).toBe(true);
		expect(readFileSync(join(b.dataRoot, "memory", "profile.md"), "utf8")).toContain("remember this");
		const restoredConversation = join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "conversation");
		const files = readdirSync(restoredConversation).filter((name) => name.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		expect(readFileSync(join(restoredConversation, files[0]!), "utf8")).toContain("hello");
		expect(
			readFileSync(join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "artifacts", "report.txt"), "utf8"),
		).toBe("artifact body");
		const workspaces = WorkspaceStore.create(b.agentDir, b.dataRoot).list();
		expect(
			workspaces.some((workspace) => workspace.workspaceId === "ws1" && workspace.modes?.includes("general")),
		).toBe(true);
		const restoredMode = new ModeStateStore(b.agentDir);
		expect(restoredMode.getPersonalPrompt("general")).toBe("Answer in Chinese.");
		expect(restoredMode.get("general").drafts.s1?.text).toBe("unfinished");
	});

	it("propagates an explicit memory deletion without resurrecting it later", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const memory = writeMemory(a.dataRoot, "delete me");
		await sync(a, b);
		expect(existsSync(join(b.dataRoot, "memory", "profile.md"))).toBe(true);

		rmSync(memory);
		await sync(a, b);
		expect(existsSync(join(b.dataRoot, "memory", "profile.md"))).toBe(false);

		// The old record must not come back from a device that still has it in a queue.
		await sync(a, b);
		expect(existsSync(join(b.dataRoot, "memory", "profile.md"))).toBe(false);
	});

	it("merges both edits of the same memory until both devices hold the same text", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		writeMemory(a.dataRoot, "base");
		await sync(a, b);
		writeMemory(a.dataRoot, "edited on desktop");
		writeMemory(b.dataRoot, "edited on laptop");

		await sync(a, b);
		await sync(a, b);

		const desktop = readFileSync(join(a.dataRoot, "memory", "profile.md"), "utf8");
		const laptop = readFileSync(join(b.dataRoot, "memory", "profile.md"), "utf8");
		expect(desktop).toContain("edited on desktop");
		expect(desktop).toContain("edited on laptop");
		expect(laptop).toBe(desktop);
		// Automatic merging converges: no review entry is left behind and neither device keeps a stale warning.
		expect(a.engine.status().conflicts).toHaveLength(0);
		expect(b.engine.status().conflicts).toHaveLength(0);
		// Converged: another pass must not publish anything, or the two machines would keep rewriting the same file.
		const batches = drive.batchNames().length;
		await sync(a, b);
		expect(drive.batchNames()).toHaveLength(batches);
	});

	it("merges two chat branches instead of replacing one with the other", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const file = writeSession(a.dataRoot);
		await sync(a, b);
		const bFile = join(
			b.dataRoot,
			"workspaces",
			"ws1",
			"sessions",
			"s1",
			"conversation",
			readdirSync(join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "conversation"))[0]!,
		);
		appendEntry(file, {
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-01-02T00:00:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "desktop branch" }] },
		});
		appendEntry(bFile, {
			type: "message",
			id: "e3",
			parentId: "e1",
			timestamp: "2026-01-02T00:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "laptop branch" }] },
		});

		await sync(a, b);
		await sync(a, b);

		for (const root of [a.dataRoot, b.dataRoot]) {
			const directory = join(root, "workspaces", "ws1", "sessions", "s1", "conversation");
			const name = readdirSync(directory).find((item) => item.endsWith(".jsonl"))!;
			const text = readFileSync(join(directory, name), "utf8");
			expect(text).toContain("desktop branch");
			expect(text).toContain("laptop branch");
		}
	});

	it("does not let an empty draft erase a non-empty local draft without a review copy", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		writeSession(a.dataRoot);
		const aState = new ModeStateStore(a.agentDir);
		aState.setDraft("general", "s1", { text: "shared draft", attachments: [] });
		await sync(a, b);
		expect(new ModeStateStore(b.agentDir).get("general").drafts.s1?.text).toBe("shared draft");

		aState.setDraft("general", "s1", null); // deleted here
		new ModeStateStore(b.agentDir).setDraft("general", "s1", { text: "typed on laptop", attachments: [] });
		await sync(a, b);

		expect(new ModeStateStore(b.agentDir).get("general").drafts.s1?.text).toBe("typed on laptop");
		expect(b.engine.status().conflicts.some((conflict) => conflict.key === "draft:s1")).toBe(true);
	});

	it("keeps a forced publish across a restart so a merged memory is not left only on this computer", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		writeMemory(a.dataRoot, "same content");
		await a.engine.runOnce();
		const before = drive.batchNames().length;

		const state = a.store.state("account-1");
		state.forceUploads = ["memory:memory/profile.md"];
		a.store.saveState(state);
		const restarted = new SyncEngine({
			agentDir: a.agentDir,
			dataRoot: a.dataRoot,
			deviceId: "device-a",
			deviceName: "desktop",
			store: a.store,
			accountKey: "account-1",
		});
		restarted.setDrive(drive);
		await restarted.runOnce();

		expect(drive.batchNames().length).toBe(before + 1);
		expect(restarted.loadState().forceUploads).toHaveLength(0);
	});

	it("uploads nothing when nothing changed, and waits for a missing object instead of applying half a batch", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		writeMemory(a.dataRoot, "one");
		await a.engine.runOnce();
		const batches = drive.batchNames().length;
		await a.engine.runOnce();
		expect(drive.batchNames()).toHaveLength(batches);

		writeMemory(a.dataRoot, "two");
		await a.engine.runOnce();
		const objectHashes = [...drive.folders.get("objects")!.keys()];
		const newest = objectHashes.at(-1)!;
		drive.hiddenObjects.add(newest);
		const b = device(drive, "laptop", "device-b");
		await b.engine.runOnce();
		expect(readFileSync(join(b.dataRoot, "memory", "profile.md"), "utf8")).toContain("one");
		expect(b.engine.status().pendingDownloads).toBeGreaterThan(0);
		drive.hiddenObjects.delete(newest);
		await b.engine.runOnce();
		expect(readFileSync(join(b.dataRoot, "memory", "profile.md"), "utf8")).toContain("two");
	});

	it("applies every batch once and never re-reads an already applied batch", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		writeMemory(a.dataRoot, "once");
		await a.engine.runOnce();
		await b.engine.runOnce();
		const readsAfterFirst = drive.batchReads;
		const conflictsAfterFirst = b.engine.status().conflicts.length;
		await b.engine.runOnce();
		expect(drive.batchReads).toBe(readsAfterFirst);
		expect(b.engine.status().conflicts).toHaveLength(conflictsAfterFirst);
		expect(existsSync(join(b.dataRoot, "memory", "profile.md"))).toBe(true);
	});

	it("restores the edit made on another device when this device deleted the memory at the same time", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const memory = writeMemory(a.dataRoot, "base");
		await sync(a, b);

		rmSync(memory);
		writeMemory(b.dataRoot, "edited on laptop");
		await sync(a, b);
		await sync(a, b);

		// An edit wins over a concurrent deletion, so the deleted copy comes back instead of a review entry that both
		// devices would have to resolve by hand.
		expect(readFileSync(join(a.dataRoot, "memory", "profile.md"), "utf8")).toContain("edited on laptop");
		expect(readFileSync(join(b.dataRoot, "memory", "profile.md"), "utf8")).toContain("edited on laptop");
		expect(a.engine.status().conflicts).toHaveLength(0);
		expect(b.engine.status().conflicts).toHaveLength(0);
	});

	it("restores an unknown Workspace into a managed folder and binds the real folder only when the user picks it", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		writeWorkspace(a.dataRoot);
		await sync(a, b);

		const restored = WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws1");
		expect(restored).toBeTruthy();
		expect(restored!.rootPath.startsWith(join(b.dataRoot, "workspace-folders"))).toBe(true);
		expect(restored!.rootPath).not.toBe(join(a.dataRoot, "workspace-folders", "study"));
		expect(b.engine.status().pendingBindings.map((item) => item.workspaceId)).toEqual(["ws1"]);

		const chosen = join(b.root, "Drive", "Study");
		mkdirSync(chosen, { recursive: true });
		expect(await b.engine.bindWorkspace("ws1", chosen)).toEqual({ ok: true });
		expect(WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws1")!.rootPath).toBe(chosen);
		expect(b.engine.status().pendingBindings).toHaveLength(0);

		// The binding is remembered locally, so a later pass keeps the chosen folder.
		await b.engine.runOnce();
		expect(WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws1")!.rootPath).toBe(chosen);
	});

	it("merges a memory conflict left by an older version instead of keeping the warning forever", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		writeMemory(a.dataRoot, "# Notes\n- kept locally\n");
		const copy = join(a.root, "recovered-copy.md");
		writeFileSync(copy, "# Notes\n- from the other device\n");
		const state = a.store.state("account-1");
		state.conflicts.push({
			id: "legacy-1",
			key: "memory:memory/profile.md",
			kind: "memory",
			reason: "both-modified",
			at: new Date().toISOString(),
			deviceName: "laptop",
			remoteCopyPath: copy,
			localPath: join(a.dataRoot, "memory", "profile.md"),
			message: "Both devices changed this item.",
		});
		a.store.saveState(state);
		a.engine.loadState();

		await a.engine.runOnce();

		const text = readFileSync(join(a.dataRoot, "memory", "profile.md"), "utf8");
		expect(text).toContain("kept locally");
		expect(text).toContain("from the other device");
		expect(a.engine.status().conflicts).toHaveLength(0);
	});

	it("follows a Drive-backed Workspace to the same relative folder on the second device without asking", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const driveRootA = mkdtempSync(join(tmpdir(), "myharness-drive-a-"));
		const driveRootB = mkdtempSync(join(tmpdir(), "myharness-drive-b-"));
		roots.push(driveRootA, driveRootB);
		const folderA = join(driveRootA, "Study", "OS");
		const folderB = join(driveRootB, "Study", "OS");
		mkdirSync(folderA, { recursive: true });
		mkdirSync(folderB, { recursive: true });
		writeWorkspace(a.dataRoot, "ws1", folderA);

		process.env.MYHARNESS_DRIVE_ROOTS = driveRootA;
		await a.engine.runOnce();
		process.env.MYHARNESS_DRIVE_ROOTS = driveRootB;
		await b.engine.runOnce();

		const restored = WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws1");
		expect(restored).toBeTruthy();
		// Drive roots are canonicalized (an 8.3 temp path such as RUNNER~1 resolves to its long name).
		expect(restored!.rootPath).toBe(resolveCanonicalPath(folderB));
		expect(b.engine.status().pendingBindings).toHaveLength(0);
	});

	it("refuses to run when the Data root sits inside a cloud-synced folder", async () => {
		expect(detectExternalSyncRisk(join("C:", "Users", "me", "My Drive", "MyHarnessData")).detected).toBe(true);
		expect(detectExternalSyncRisk(join("C:", "Users", "me", "OneDrive", "data")).detected).toBe(true);
		expect(detectExternalSyncRisk(join("C:", "Users", "me", "AppData", "MyHarness")).detected).toBe(false);

		const drive = new FakeDrive();
		const root = mkdtempSync(join(tmpdir(), "myharness-sync-risk-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const dataRoot = join(root, "My Drive", "data");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(dataRoot, { recursive: true });
		const store = new SyncLocalStore(agentDir);
		const config = store.config();
		config.enabled = true;
		store.saveConfig(config);
		const engine = new SyncEngine({
			agentDir,
			dataRoot,
			deviceId: "device-risk",
			deviceName: "risk",
			store,
			accountKey: "account-1",
		});
		engine.setDrive(drive);
		await engine.start();
		const status = engine.status();
		expect(status.phase).toBe("error");
		expect(status.lastError).toContain("cloud-synced folder");
		expect(drive.batchNames()).toHaveLength(0);
		await engine.dispose();
	});

	it("publishes a large change set as several batches and restores every item", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		writeWorkspace(a.dataRoot);
		const folder = join(a.dataRoot, "workspaces", "ws1", "artifacts");
		mkdirSync(folder, { recursive: true });
		for (let index = 0; index < 501; index += 1) writeFileSync(join(folder, `note-${index}.txt`), `body ${index}`);

		await a.engine.runOnce();
		expect(drive.batchNames().length).toBeGreaterThan(1);
		await b.engine.runOnce();
		expect(readdirSync(join(b.dataRoot, "workspaces", "ws1", "artifacts"))).toHaveLength(501);
		expect(b.engine.status().pendingDownloads).toBe(0);
	});

	it("never replays a batch that came from this same device", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const ownBatch = {
			version: 1,
			batchId: "device-a-own-1",
			deviceId: "device-a",
			deviceName: "desktop",
			createdAt: "2026-01-02T00:00:00.000Z",
			operations: [
				{
					op: "put",
					kind: "memory",
					id: "memory/own.md",
					key: "memory:memory/own.md",
					hash: "0".repeat(64),
					size: 1,
					vector: { "device-a": 7 },
					updatedAt: "2026-01-02T00:00:00.000Z",
				},
			],
		};
		await drive.write("batches", "device-a-own-1.json", new TextEncoder().encode(JSON.stringify(ownBatch)));

		await a.engine.runOnce();
		await a.engine.runOnce();

		expect(existsSync(join(a.dataRoot, "memory", "own.md"))).toBe(false);
		expect(a.store.state("account-1").appliedBatches).toContain("device-a-own-1.json");
		expect(a.engine.status().pendingDownloads).toBe(0);
		expect(a.engine.status().conflicts).toHaveLength(0);
		expect(a.engine.status().issues).toHaveLength(0);
	});

	it("refuses remote records whose identity is not a safe path segment", async () => {
		const drive = new FakeDrive();
		const b = device(drive, "laptop", "device-b");
		const hostile = {
			version: 1,
			batchId: "device-x-hostile",
			deviceId: "device-x",
			deviceName: "other",
			createdAt: "2026-01-02T00:00:00.000Z",
			operations: [
				{
					op: "put",
					kind: "session",
					id: "../../escape/1",
					key: "session:../../escape/1",
					hash: "1".repeat(64),
					size: 1,
					vector: { "device-x": 1 },
					updatedAt: "2026-01-02T00:00:00.000Z",
				},
				{
					op: "put",
					kind: "workspace",
					id: "..",
					key: "workspace:..",
					hash: "2".repeat(64),
					size: 1,
					vector: { "device-x": 1 },
					updatedAt: "2026-01-02T00:00:00.000Z",
				},
			],
		};
		await drive.write("batches", "hostile.json", new TextEncoder().encode(JSON.stringify(hostile)));

		await b.engine.runOnce();

		expect(existsSync(join(b.root, "escape"))).toBe(false);
		expect(existsSync(join(b.dataRoot, "..", "escape"))).toBe(false);
		expect(b.engine.status().issues.some((issue) => issue.reason === "invalid-record")).toBe(true);
	});

	it("reports a damaged batch once and stops re-reading it", async () => {
		const drive = new FakeDrive();
		const b = device(drive, "laptop", "device-b");
		await drive.write("batches", "broken.json", new TextEncoder().encode("{ not json"));

		await b.engine.runOnce();
		expect(b.engine.status().issues.some((issue) => issue.reason === "unreadable-batch")).toBe(true);
		const reads = drive.batchReads;
		await b.engine.runOnce();
		expect(drive.batchReads).toBe(reads);
	});

	it("stops waiting forever for an object that never arrives and says so", async () => {
		const drive = new FakeDrive();
		const b = device(drive, "laptop", "device-b");
		const orphan = {
			version: 1,
			batchId: "device-x-orphan",
			deviceId: "device-x",
			deviceName: "other",
			createdAt: "2026-01-02T00:00:00.000Z",
			operations: [
				{
					op: "put",
					kind: "memory",
					id: "memory/lost.md",
					key: "memory:memory/lost.md",
					hash: "3".repeat(64),
					size: 4,
					vector: { "device-x": 1 },
					updatedAt: "2026-01-02T00:00:00.000Z",
				},
			],
		};
		await drive.write("batches", "orphan.json", new TextEncoder().encode(JSON.stringify(orphan)));

		for (let pass = 0; pass < 7; pass += 1) await b.engine.runOnce();

		expect(b.engine.status().issues.some((issue) => issue.reason === "missing-object")).toBe(true);
		expect(b.engine.status().pendingDownloads).toBe(0);
		expect(existsSync(join(b.dataRoot, "memory", "lost.md"))).toBe(false);
	});

	it("syncs the archive marker and ordinary JSON files that live beside artifacts", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const conversationFile = writeSession(a.dataRoot);
		writeFileSync(`${conversationFile}.archived`, "");
		mkdirSync(join(a.dataRoot, "workspaces", "ws1", "artifacts"), { recursive: true });
		writeFileSync(join(a.dataRoot, "workspaces", "ws1", "artifacts", "index.json"), '{"kept":true}');

		await sync(a, b);

		const restored = join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "conversation");
		expect(readdirSync(restored).some((name) => name.endsWith(".jsonl.archived"))).toBe(true);
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "artifacts", "index.json"), "utf8")).toContain("kept");
	});

	it("does not publish a Workspace the user removed from every list, and publishes it again after re-adding", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const folder = join(a.root, "Study");
		mkdirSync(folder, { recursive: true });
		const registry = WorkspaceStore.create(a.agentDir, a.dataRoot);
		const input = {
			workspaceId: "ws1",
			name: "Study",
			rootPath: folder,
			modes: ["general"] as ("general" | "coding")[],
		};
		expect(registry.importWorkspace(input).ok).toBe(true);
		writeSession(a.dataRoot);
		expect(registry.remove("ws1", "general")).toBe(true);

		await a.engine.runOnce();
		expect(drive.batchNames()).toHaveLength(0);

		expect(WorkspaceStore.create(a.agentDir, a.dataRoot).add(folder, process.cwd(), true, "general").ok).toBe(true);
		await a.engine.runOnce();
		expect(drive.batchNames().length).toBeGreaterThan(0);
		await b.engine.runOnce();
		expect(
			WorkspaceStore.create(b.agentDir, b.dataRoot)
				.list("general")
				.some((workspace) => workspace.workspaceId === "ws1"),
		).toBe(true);
	});

	it("keeps a remote chat version even when the merge itself changes nothing", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const file = writeSession(a.dataRoot);
		await sync(a, b);
		const bFile = join(
			b.dataRoot,
			"workspaces",
			"ws1",
			"sessions",
			"s1",
			"conversation",
			readdirSync(join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "conversation"))[0]!,
		);
		// Both devices rewrite entry e1 with the same id but different text: the merge keeps the local entry and
		// changes nothing else, which used to drop the other version without a copy.
		writeFileSync(file, readFileSync(file, "utf8").replace('"hello"', '"desktop text"'));
		writeFileSync(bFile, readFileSync(bFile, "utf8").replace('"hello"', '"laptop text"'));

		await sync(a, b);

		const conflict = b.engine.status().conflicts.find((item) => item.key === "session:ws1/s1");
		expect(conflict).toBeTruthy();
		expect(conflict!.remoteCopyPath).toBeTruthy();
		expect(readFileSync(conflict!.remoteCopyPath!, "utf8")).toContain("desktop text");
		expect(readFileSync(bFile, "utf8")).toContain("laptop text");
	});

	it("never lets a remote timestamp decide where a chat file is written", async () => {
		const drive = new FakeDrive();
		const b = device(drive, "laptop", "device-b");
		const header = `${JSON.stringify({ type: "session", version: 3, id: "s1", mode: "general" })}\n`;
		const body = new TextEncoder().encode(header);
		const hash = createHash("sha256").update(body).digest("hex");
		await drive.uploadObject(hash, body);
		const hostile = {
			version: 1,
			batchId: "device-x-timestamp",
			deviceId: "device-x",
			deviceName: "other",
			createdAt: "2026-01-02T00:00:00.000Z",
			operations: [
				{
					op: "put",
					kind: "session",
					id: "ws1/s1",
					key: "session:ws1/s1",
					hash,
					size: body.byteLength,
					vector: { "device-x": 1 },
					updatedAt: "../../../../evil",
				},
			],
		};
		await drive.write("batches", "timestamp.json", new TextEncoder().encode(JSON.stringify(hostile)));

		await b.engine.runOnce();

		const expected = join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "conversation");
		const written = readdirSync(expected).filter((name) => name.endsWith(".jsonl"));
		expect(written).toHaveLength(1);
		expect(written[0]).toMatch(/^[0-9A-Za-z-]+_s1\.jsonl$/u);
		const stray = readdirSync(b.root, { recursive: true })
			.map((name) => String(name))
			.filter(
				(name) =>
					name.includes("evil") && !name.includes(join("workspaces", "ws1", "sessions", "s1", "conversation")),
			);
		expect(stray).toHaveLength(0);
	});

	it("lets a prompt be cleared and set again after a synced delete", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const aState = new ModeStateStore(a.agentDir);
		aState.setPersonalPrompt("general", "first");
		await sync(a, b);
		expect(new ModeStateStore(b.agentDir).getPersonalPrompt("general")).toBe("first");

		aState.setPersonalPrompt("general", "");
		await sync(a, b);
		expect(new ModeStateStore(b.agentDir).getPersonalPrompt("general")).toBe("");

		aState.setPersonalPrompt("general", "second");
		await sync(a, b);
		expect(new ModeStateStore(b.agentDir).getPersonalPrompt("general")).toBe("second");
	});

	it("carries the saved prompts list between devices and leaves every other preference alone", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const prefsOf = (agentDir: string) => readWebPrefs(agentDir)!;
		writeWebPrefs(a.agentDir, {
			prefs: {
				theme: "dark",
				savedPrompts: ["Review this\nby severity", { title: "Translate", text: "Into English" }],
			},
			updatedAt: 1000,
		});
		writeWebPrefs(b.agentDir, { prefs: { theme: "light", panelW: 480 }, updatedAt: 5000 });
		await sync(a, b);
		const onB = prefsOf(b.agentDir);
		expect(onB.prefs.savedPrompts).toEqual([
			{ title: "Review this", text: "Review this\nby severity" },
			{ title: "Translate", text: "Into English" },
		]);
		expect(onB.prefs.theme).toBe("light");
		expect(onB.prefs.panelW).toBe(480);
		// A page that saved its preferences before the list arrived must not be able to write the old list back.
		expect(onB.updatedAt).toBeGreaterThan(5000);
		// The personal prompt is a different record and stays untouched.
		expect(new ModeStateStore(b.agentDir).getPersonalPrompt("general")).toBe("");

		// Edited on the second device, emptied on the first one: both changes travel.
		writeWebPrefs(b.agentDir, {
			prefs: { ...onB.prefs, savedPrompts: [{ title: "Only", text: "One left" }] },
			updatedAt: Date.now(),
		});
		await sync(b, a);
		expect(prefsOf(a.agentDir).prefs.savedPrompts).toEqual([{ title: "Only", text: "One left" }]);
		writeWebPrefs(a.agentDir, { prefs: { ...prefsOf(a.agentDir).prefs, savedPrompts: [] }, updatedAt: Date.now() });
		await sync(a, b);
		expect(prefsOf(b.agentDir).prefs.savedPrompts).toEqual([]);
		expect(prefsOf(b.agentDir).prefs.theme).toBe("light");
	});
});

describe("Google OAuth client configuration", () => {
	it("stores the client id and secret trimmed on this device", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-sync-client-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const store = new SyncLocalStore(agentDir);
		const config = store.config();
		config.clientId = " 123-abc.apps.googleusercontent.com ";
		config.clientSecret = " GOCSPX-test ";
		store.saveConfig(config);

		const reread = new SyncLocalStore(agentDir).config();
		expect(reread.clientId).toBe("123-abc.apps.googleusercontent.com");
		expect(reread.clientSecret).toBe("GOCSPX-test");
	});

	it("reports whether a secret is stored without returning its value", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-sync-status-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const dataRoot = join(root, "data");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(dataRoot, { recursive: true });
		const service = SyncService.create({ agentDir, dataRoot });
		expect(service.status().clientSecretConfigured).toBe(false);

		const status = await service.updateConfig({
			clientId: "123-abc.apps.googleusercontent.com",
			clientSecret: "GOCSPX-test",
		});
		expect(status.clientConfigured).toBe(true);
		expect(status.clientSecretConfigured).toBe(true);
		expect(JSON.stringify(status)).not.toContain("GOCSPX-test");
		await service.dispose();
	});
});
