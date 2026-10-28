import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWebPrefs, writeWebPrefs } from "../src/config/web-prefs.ts";
import { WorkspaceStore } from "../src/data/workspace-store.ts";
import { ModeStateStore } from "../src/session/mode-state.ts";
import { readSessionHeader } from "../src/session/storage/jsonl/index.ts";
import { mergeBrowserText } from "../src/sync/browser-data.ts";
import { detectExternalSyncRisk, SyncEngine } from "../src/sync/engine.ts";
import {
	mergeDraft,
	mergeSavedPrompts,
	mergeText,
	mergeTextFile,
	newerFileVersion,
	pickHandoff,
	sessionMetadataFile,
} from "../src/sync/record-merge.ts";
import { SyncService } from "../src/sync/service.ts";
import { SyncLocalStore } from "../src/sync/store.ts";
import type { DrivePort, RemoteFile, RemoteFolder } from "../src/sync/types.ts";
import { mergeWorkspaceInto } from "../src/sync/workspace-merge.ts";
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

function writeWorkspaceMemory(root: string, workspaceId: string, name: string, text: string): string {
	const folder = join(root, "workspaces", workspaceId, "memory");
	mkdirSync(folder, { recursive: true });
	const file = join(folder, name);
	writeFileSync(
		file,
		`---\nid: workspace/${name.replace(/\.md$/u, "")}\nname: ${name}\ndescription: shared\ntype: project\nscope: workspace\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n${text}\n`,
	);
	return file;
}

/** A chat's metadata/session.json as the app writes it (`writeSessionMetadata`), with this computer's paths. */
function writeChatMetadata(root: string, cwd: string, updatedAt: string, conversationPath: string): string {
	const folder = join(root, "workspaces", "ws1", "sessions", "s1", "metadata");
	mkdirSync(folder, { recursive: true });
	const file = join(folder, "session.json");
	const metadata = {
		version: 1,
		sessionId: "s1",
		workspaceId: "ws1",
		cwd,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt,
		conversationPath,
	};
	writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
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

	it("keeps file hashes across a restart and hashes a file again only when its size or time changed", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const chat = writeSession(a.dataRoot);
		// A whole-millisecond time, so setting it back below gives exactly the time the hash was taken at.
		const stamp = new Date("2026-01-01T00:00:05.000Z");
		utimesSync(chat, stamp, stamp);
		await a.engine.runOnce();
		await a.engine.stop();
		expect(a.store.hashCache("account-1").get("session:ws1/s1")?.size).toBe(statSync(chat).size);
		const before = drive.batchNames().length;
		const restart = () => {
			const engine = new SyncEngine({
				agentDir: a.agentDir,
				dataRoot: a.dataRoot,
				deviceId: "device-a",
				deviceName: "desktop",
				store: a.store,
				accountKey: "account-1",
			});
			engine.setDrive(drive);
			return engine;
		};

		// Same size and time as when it was hashed: the saved hash stands for it, the file is not read again.
		writeFileSync(chat, readFileSync(chat, "utf8").replace("hello", "HELLO"));
		utimesSync(chat, stamp, stamp);
		await restart().runOnce();
		expect(drive.batchNames()).toHaveLength(before);

		appendEntry(chat, { type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:02.000Z" });
		await restart().runOnce();
		expect(drive.batchNames()).toHaveLength(before + 1);
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

	it("stops asking for a folder once the restored Workspace is removed from every list, here or on the other device", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		writeWorkspace(a.dataRoot);
		await sync(a, b);
		const placeholder = WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws1")!.rootPath;
		expect(b.engine.status().pendingBindings.map((item) => item.workspaceId)).toEqual(["ws1"]);

		expect(WorkspaceStore.create(b.agentDir, b.dataRoot).remove("ws1", "general")).toBe(true);
		expect(b.engine.status().pendingBindings).toHaveLength(0);
		// Added back, it waits for its folder again.
		expect(WorkspaceStore.create(b.agentDir, b.dataRoot).add(placeholder, b.root, true, "general").ok).toBe(true);
		expect(b.engine.status().pendingBindings.map((item) => item.workspaceId)).toEqual(["ws1"]);

		// Removed on the device that created it: the removal reaches this device and the request goes with it.
		expect(WorkspaceStore.create(a.agentDir, a.dataRoot).remove("ws1", "general")).toBe(true);
		await sync(a, b);
		expect(WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws1")?.modes).toEqual([]);
		expect(b.engine.status().pendingBindings).toHaveLength(0);
	});

	it("merges a restored Workspace into the one that holds its folder, and the other device follows", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		const chat = writeSession(a.dataRoot, "ws-a", "s1");
		const memory = writeWorkspaceMemory(a.dataRoot, "ws-a", "course-plan.md", "planned on the desktop");
		writeSession(b.dataRoot, "ws-b", "s2");
		await sync(a, b, a);

		const merged = await mergeWorkspaceInto(
			WorkspaceStore.create(b.agentDir, b.dataRoot),
			b.dataRoot,
			"ws-a",
			"ws-b",
		);
		expect(merged).toMatchObject({ chats: 1, memories: 1, kept: [] });
		const moved = join(b.dataRoot, "workspaces", "ws-b", "sessions", "s1", "conversation", basename(chat));
		expect(readSessionHeader(moved)?.workspaceId).toBe("ws-b");
		expect(readFileSync(moved, "utf8")).toContain("hello");
		expect(existsSync(join(b.dataRoot, "workspaces", "ws-a", "sessions", "s1"))).toBe(false);
		expect(existsSync(join(b.dataRoot, "workspaces", "ws-b", "memory", "course-plan.md"))).toBe(true);
		expect(WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws-a")?.modes).toEqual([]);

		await sync(b, a);
		// The desktop ends up with the same single Workspace: the chat and the memory moved, the merged one left its lists.
		const arrived = join(a.dataRoot, "workspaces", "ws-b", "sessions", "s1", "conversation", basename(chat));
		expect(readFileSync(arrived, "utf8")).toBe(readFileSync(moved, "utf8"));
		expect(existsSync(chat)).toBe(false);
		expect(existsSync(join(a.dataRoot, "workspaces", "ws-b", "memory", "course-plan.md"))).toBe(true);
		expect(existsSync(memory)).toBe(false);
		expect(WorkspaceStore.create(a.agentDir, a.dataRoot).getById("ws-a")?.modes).toEqual([]);
		expect(a.engine.status().conflicts).toHaveLength(0);
		expect(b.engine.status().conflicts).toHaveLength(0);
	});

	it("merges only with the confirmation and never while a chat of the merged Workspace runs", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-merge-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const dataRoot = join(root, "data");
		mkdirSync(agentDir, { recursive: true });
		const chat = writeSession(dataRoot, "ws-a", "s1");
		writeWorkspace(dataRoot, "ws-b", join(root, "folder-b"));
		const released: string[][] = [];
		const service = (running: boolean) =>
			SyncService.create({
				agentDir,
				dataRoot,
				isSessionActive: (workspaceId, sessionId) => running && workspaceId === "ws-a" && sessionId === "s1",
				releaseSessions: async (files) => {
					released.push(files);
				},
			});

		const busy = service(true);
		await expect(busy.mergeWorkspace("ws-a", "ws-b", false)).rejects.toThrow("confirmation");
		await expect(busy.mergeWorkspace("ws-a", "ws-b", true)).rejects.toThrow("still running");
		await busy.dispose();
		expect(released).toEqual([]);
		expect(existsSync(chat)).toBe(true);

		const idle = service(false);
		const { merged } = await idle.mergeWorkspace("ws-a", "ws-b", true);
		await idle.dispose();
		// The open chat on the old file is released before the file moves.
		expect(released).toEqual([[chat]]);
		expect(merged.chats).toBe(1);
		expect(existsSync(join(dataRoot, "workspaces", "ws-b", "sessions", "s1", "conversation", basename(chat)))).toBe(
			true,
		);
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

	describe("edits made on both computers", () => {
		const converged = async (drive: FakeDrive, a: Device, b: Device) => {
			expect(a.engine.status().conflicts).toHaveLength(0);
			expect(b.engine.status().conflicts).toHaveLength(0);
			// Nothing left to publish: two computers that kept rewriting each other's version would add batches here.
			const batches = drive.batchNames().length;
			await sync(a, b);
			await sync(a, b);
			expect(drive.batchNames()).toHaveLength(batches);
		};

		it("merges both edits of the personal prompt, so both computers end with the same text", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const b = device(drive, "laptop", "device-b");
			const prompt = (second: string, fourth: string) => `Answer in Chinese.\n${second}\nUse lists.\n${fourth}`;
			new ModeStateStore(a.agentDir).setPersonalPrompt("general", prompt("Be brief.", "Cite sources."));
			await sync(a, b);
			new ModeStateStore(a.agentDir).setPersonalPrompt("general", prompt("Be brief and direct.", "Cite sources."));
			new ModeStateStore(b.agentDir).setPersonalPrompt("general", prompt("Be brief.", "Cite sources with links."));

			await sync(a, b);
			await sync(a, b);

			// Each computer changed another line of the version both had: both changes are in the result.
			const desktop = new ModeStateStore(a.agentDir).getPersonalPrompt("general");
			expect(desktop).toBe(prompt("Be brief and direct.", "Cite sources with links."));
			expect(new ModeStateStore(b.agentDir).getPersonalPrompt("general")).toBe(desktop);
			await converged(drive, a, b);

			// Both changed the same line: neither version of it is dropped.
			new ModeStateStore(a.agentDir).setPersonalPrompt("general", prompt("Be brief and direct.", "Cite: desktop"));
			new ModeStateStore(b.agentDir).setPersonalPrompt("general", prompt("Be brief and direct.", "Cite: laptop"));
			await sync(a, b);
			await sync(a, b);
			const both = new ModeStateStore(a.agentDir).getPersonalPrompt("general");
			expect(both).toContain("Cite: desktop");
			expect(both).toContain("Cite: laptop");
			expect(new ModeStateStore(b.agentDir).getPersonalPrompt("general")).toBe(both);
			await converged(drive, a, b);
		});

		it("merges a draft and the saved prompts both computers changed instead of keeping one", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const b = device(drive, "laptop", "device-b");
			writeSession(a.dataRoot);
			new ModeStateStore(a.agentDir).setDraft("general", "s1", { text: "Plan:", attachments: [] });
			writeWebPrefs(a.agentDir, {
				prefs: { savedPrompts: [{ title: "Review", text: "Review this" }] },
				updatedAt: 1,
			});
			await sync(a, b);

			new ModeStateStore(a.agentDir).setDraft("general", "s1", {
				text: "Plan:\n- desktop step",
				attachments: [{ id: "f1", name: "desk.png" }],
			});
			new ModeStateStore(b.agentDir).setDraft("general", "s1", {
				text: "Plan:\n- laptop step",
				attachments: [{ id: "f2", name: "lap.png" }],
			});
			const review = { title: "Review", text: "Review this" };
			writeWebPrefs(a.agentDir, {
				prefs: { savedPrompts: [review, { title: "Desk", text: "From the desktop" }] },
				updatedAt: Date.now(),
			});
			writeWebPrefs(b.agentDir, {
				prefs: {
					...readWebPrefs(b.agentDir)!.prefs,
					savedPrompts: [review, { title: "Lap", text: "From the laptop" }],
				},
				updatedAt: Date.now(),
			});

			await sync(a, b);
			await sync(a, b);

			const draft = new ModeStateStore(a.agentDir).get("general").drafts.s1!;
			expect(draft.text).toContain("- desktop step");
			expect(draft.text).toContain("- laptop step");
			expect(draft.attachments.map((file) => file.id).sort()).toEqual(["f1", "f2"]);
			expect(new ModeStateStore(b.agentDir).get("general").drafts.s1).toEqual(draft);
			const saved = readWebPrefs(a.agentDir)!.prefs.savedPrompts as { title: string }[];
			expect(saved.map((prompt) => prompt.title).sort()).toEqual(["Desk", "Lap", "Review"]);
			expect(readWebPrefs(b.agentDir)!.prefs.savedPrompts).toEqual(saved);
			await converged(drive, a, b);
		});

		it("keeps each computer's own paths in a chat's session.json and merges the rest", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const b = device(drive, "laptop", "device-b");
			const chat = writeSession(a.dataRoot);
			const onDesktop = writeChatMetadata(a.dataRoot, "C:\\Users\\desk\\Study", "2026-01-02T00:00:00.000Z", chat);
			await sync(a, b);
			const onLaptop = join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "metadata", "session.json");
			const laptopChat = join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "conversation", basename(chat));
			// The other computer's paths never arrive; the chat file's path here takes their place.
			const received = JSON.parse(readFileSync(onLaptop, "utf8")) as Record<string, unknown>;
			expect(received.conversationPath).toBe(laptopChat);
			expect(received.cwd).toBeUndefined();
			expect(received.updatedAt).toBe("2026-01-02T00:00:00.000Z");

			// Both computers write the file again, each with its own folder, as opening the chat does.
			writeChatMetadata(a.dataRoot, "C:\\Users\\desk\\Study", "2026-01-03T00:00:00.000Z", chat);
			writeChatMetadata(b.dataRoot, "C:\\Users\\lap\\Study", "2026-01-04T00:00:00.000Z", laptopChat);
			await sync(a, b);
			await sync(a, b);

			const desktop = JSON.parse(readFileSync(onDesktop, "utf8")) as Record<string, unknown>;
			const laptop = JSON.parse(readFileSync(onLaptop, "utf8")) as Record<string, unknown>;
			expect(desktop).toMatchObject({ cwd: "C:\\Users\\desk\\Study", conversationPath: chat });
			expect(laptop).toMatchObject({ cwd: "C:\\Users\\lap\\Study", conversationPath: laptopChat });
			expect(desktop.updatedAt).toBe("2026-01-04T00:00:00.000Z");
			expect(laptop.updatedAt).toBe("2026-01-04T00:00:00.000Z");
			// The two files differ only in their paths, which do not travel: nothing goes back and forth.
			await converged(drive, a, b);
		});

		it("merges a notes file both computers edited, line by line", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const b = device(drive, "laptop", "device-b");
			writeSession(a.dataRoot);
			const notes = (root: string) => join(root, "workspaces", "ws1", "sessions", "s1", "notes", "plan.md");
			mkdirSync(join(a.dataRoot, "workspaces", "ws1", "sessions", "s1", "notes"), { recursive: true });
			writeFileSync(notes(a.dataRoot), "# Plan\n- one\n- two\n");
			await sync(a, b);
			writeFileSync(notes(a.dataRoot), "# Plan\n- one\n- two\n- from the desktop\n");
			writeFileSync(notes(b.dataRoot), "# Plan\n- zero\n- one\n- two\n");

			await sync(a, b);
			await sync(a, b);

			const desktop = readFileSync(notes(a.dataRoot), "utf8");
			expect(desktop).toBe("# Plan\n- zero\n- one\n- two\n- from the desktop\n");
			expect(readFileSync(notes(b.dataRoot), "utf8")).toBe(desktop);
			await converged(drive, a, b);
		});

		it("keeps both versions of a file that cannot be merged: the newer under its name, the other beside it", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const b = device(drive, "laptop", "device-b");
			writeSession(a.dataRoot);
			const artifacts = (root: string) => join(root, "workspaces", "ws1", "sessions", "s1", "artifacts");
			mkdirSync(artifacts(a.dataRoot), { recursive: true });
			writeFileSync(join(artifacts(a.dataRoot), "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
			await sync(a, b);
			const older = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]);
			const newer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 3]);
			writeFileSync(join(artifacts(a.dataRoot), "chart.png"), older);
			utimesSync(join(artifacts(a.dataRoot), "chart.png"), new Date("2026-02-01Z"), new Date("2026-02-01Z"));
			writeFileSync(join(artifacts(b.dataRoot), "chart.png"), newer);
			utimesSync(join(artifacts(b.dataRoot), "chart.png"), new Date("2026-02-02Z"), new Date("2026-02-02Z"));

			await sync(a, b);
			await sync(a, b);

			const copy = `chart (conflicted copy ${createHash("sha256").update(older).digest("hex").slice(0, 8)}).png`;
			for (const item of [a, b]) {
				expect(readFileSync(join(artifacts(item.dataRoot), "chart.png"))).toEqual(newer);
				expect(readFileSync(join(artifacts(item.dataRoot), copy))).toEqual(older);
			}
			await converged(drive, a, b);
		});

		it("keeps the handoff summary that covers more of the chat, and never syncs a chat's search index", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const b = device(drive, "laptop", "device-b");
			writeSession(a.dataRoot);
			const metadata = (root: string) => join(root, "workspaces", "ws1", "sessions", "s1", "metadata");
			const handoff = (summary: string, coveredCount: number) =>
				JSON.stringify({
					version: 1,
					sessionId: "s1",
					summary,
					coveredCount,
					updatedAt: "2026-01-01T00:00:00.000Z",
				});
			mkdirSync(metadata(a.dataRoot), { recursive: true });
			writeFileSync(join(metadata(a.dataRoot), "handoff.json"), handoff("first", 2));
			writeFileSync(join(metadata(a.dataRoot), "history-index.json"), JSON.stringify({ version: 1, ino: 42 }));
			await sync(a, b);
			// The index records the chat file's inode on the computer that built it, so it stays there.
			expect(existsSync(join(metadata(b.dataRoot), "history-index.json"))).toBe(false);

			writeFileSync(join(metadata(a.dataRoot), "handoff.json"), handoff("desktop summary", 4));
			writeFileSync(join(metadata(b.dataRoot), "handoff.json"), handoff("laptop summary", 6));
			await sync(a, b);
			await sync(a, b);

			for (const item of [a, b]) {
				expect(readFileSync(join(metadata(item.dataRoot), "handoff.json"), "utf8")).toContain("laptop summary");
			}
			await converged(drive, a, b);
		});

		it("merges the review entries an older version left for the personal prompt and a chat's session.json", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const chat = writeSession(a.dataRoot);
			new ModeStateStore(a.agentDir).setPersonalPrompt("general", "Answer in Chinese.\nKept on this computer.");
			const metadata = writeChatMetadata(a.dataRoot, "C:\\here", "2026-01-02T00:00:00.000Z", chat);
			const promptCopy = join(a.root, "prompt-copy");
			writeFileSync(promptCopy, "Answer in Chinese.\nWritten on the laptop.");
			const metadataCopy = join(a.root, "session-copy.json");
			writeFileSync(
				metadataCopy,
				JSON.stringify({
					version: 1,
					sessionId: "s1",
					workspaceId: "ws1",
					cwd: "C:\\there",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-05T00:00:00.000Z",
					conversationPath: "C:\\there\\chat.jsonl",
				}),
			);
			const entry = { reason: "both-modified" as const, at: new Date().toISOString(), deviceName: "laptop" };
			const state = a.store.state("account-1");
			state.conflicts.push(
				{
					...entry,
					id: "old-prompt",
					key: "prompt:general",
					kind: "prompt",
					remoteCopyPath: promptCopy,
					message: "",
				},
				{
					...entry,
					id: "old-metadata",
					key: "file:workspaces/ws1/sessions/s1/metadata/session.json",
					kind: "file",
					remoteCopyPath: metadataCopy,
					message: "",
				},
			);
			a.store.saveState(state);
			a.engine.loadState();

			await a.engine.runOnce();

			const prompt = new ModeStateStore(a.agentDir).getPersonalPrompt("general");
			expect(prompt).toContain("Kept on this computer.");
			expect(prompt).toContain("Written on the laptop.");
			expect(JSON.parse(readFileSync(metadata, "utf8"))).toMatchObject({
				cwd: "C:\\here",
				conversationPath: chat,
				updatedAt: "2026-01-05T00:00:00.000Z",
			});
			expect(a.engine.status().conflicts).toHaveLength(0);
		});
	});

	describe("built-in browser", () => {
		const profile = (item: Device) => join(item.agentDir, "desktop-profile");
		const writeProfile = (item: Device, name: string, value: unknown) => {
			mkdirSync(profile(item), { recursive: true });
			writeFileSync(
				join(profile(item), name),
				typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
			);
		};
		const readProfile = (item: Device, name: string) => readFileSync(join(profile(item), name), "utf8");
		const bookmark = (id: string, url: string, addedAt: string) => ({ id, title: id, url, addedAt });

		it("combines the bookmarks both computers had and carries the site settings", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const b = device(drive, "laptop", "device-b");
			const gmail = "https://mail.google.com/mail/u/0/";
			writeProfile(a, "browser-bookmarks.json", {
				version: 1,
				bookmarks: [bookmark("a1", gmail, "2026-10-01T00:00:00.000Z")],
			});
			writeProfile(a, "browser-zoom.json", { version: 1, sites: { "a.example": 1.25 } });
			writeProfile(b, "browser-bookmarks.json", {
				version: 1,
				bookmarks: [
					bookmark("b1", "https://www.bilibili.com/", "2026-10-02T00:00:00.000Z"),
					bookmark("b2", gmail, "2026-10-03T00:00:00.000Z"),
				],
			});
			await sync(a, b, a, b);
			const onA = readProfile(a, "browser-bookmarks.json");
			expect(readProfile(b, "browser-bookmarks.json")).toBe(onA);
			// The same page saved on both computers is kept once, as the one saved first; the order is the order added.
			expect(JSON.parse(onA).bookmarks.map((item: { id: string }) => item.id)).toEqual(["a1", "b1"]);
			expect(JSON.parse(readProfile(b, "browser-zoom.json")).sites).toEqual({ "a.example": 1.25 });
			expect(a.engine.status().conflicts).toHaveLength(0);
			expect(b.engine.status().conflicts).toHaveLength(0);

			// Edited on both computers between two passes: both edits survive and both computers end with one list.
			const both = JSON.parse(onA);
			writeProfile(a, "browser-bookmarks.json", {
				...both,
				bookmarks: [...both.bookmarks, bookmark("a3", "https://a3.example/", "2026-10-05T00:00:00.000Z")],
			});
			writeProfile(b, "browser-bookmarks.json", {
				...both,
				bookmarks: [...both.bookmarks, bookmark("b3", "https://b3.example/", "2026-10-04T00:00:00.000Z")],
			});
			await sync(a, b, a, b);
			const merged = readProfile(a, "browser-bookmarks.json");
			expect(readProfile(b, "browser-bookmarks.json")).toBe(merged);
			expect(JSON.parse(merged).bookmarks.map((item: { id: string }) => item.id)).toEqual(["a1", "b1", "b3", "a3"]);
			expect(b.engine.status().conflicts).toHaveLength(0);
		});

		it("never removes a browser file from another computer, and passes a sealed vault on untouched", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const b = device(drive, "laptop", "device-b");
			writeProfile(a, "browser-dark.json", { version: 1, mode: "on", sites: {} });
			writeProfile(a, "browser-vault-0123456789abcdef.json", '{"version":1,"sealed":"opaque"}');
			// Engine files of the profile are not browser data and stay where they are.
			writeProfile(a, "Preferences", "{}");
			await sync(a, b);
			expect(readProfile(b, "browser-vault-0123456789abcdef.json")).toBe('{"version":1,"sealed":"opaque"}');
			expect(existsSync(join(profile(b), "Preferences"))).toBe(false);
			rmSync(join(profile(a), "browser-dark.json"));
			await sync(a, b, a);
			expect(JSON.parse(readProfile(b, "browser-dark.json")).mode).toBe("on");
			expect(JSON.parse(readProfile(a, "browser-dark.json")).mode).toBe("on");
		});

		it("keeps one new-tab layout and adds the shortcuts only the other computer has", async () => {
			const drive = new FakeDrive();
			const a = device(drive, "desktop", "device-a");
			const b = device(drive, "laptop", "device-b");
			const site = (id: string, url: string) => ({ id, type: "site", title: id, url });
			writeProfile(a, "browser-speed-dial.json", { version: 1, items: [site("s1", "https://one.example/")] });
			await sync(a, b);
			writeProfile(a, "browser-speed-dial.json", {
				version: 1,
				items: [site("s1", "https://one.example/"), site("s2", "https://two.example/")],
			});
			writeProfile(b, "browser-speed-dial.json", {
				version: 1,
				items: [site("s3", "https://three.example/"), site("s1", "https://one.example/")],
			});
			await sync(a, b, a, b);
			const onA = readProfile(a, "browser-speed-dial.json");
			expect(readProfile(b, "browser-speed-dial.json")).toBe(onA);
			expect(
				JSON.parse(onA)
					.items.map((item: { id: string }) => item.id)
					.sort(),
			).toEqual(["s1", "s2", "s3"]);
		});
	});
});

describe("browser file merge", () => {
	it("gives the same text whichever side is local, and a refusal on either side wins", () => {
		const pairs: [string, unknown, unknown][] = [
			["zoom", { version: 1, sites: { x: 1.1, y: 2 } }, { version: 1, sites: { x: 1.5, z: 0.9 } }],
			["dark", { version: 1, mode: "on", sites: { x: "off" } }, { version: 1, mode: "auto", sites: { x: "on" } }],
			["language", { version: 1, language: "zh-CN" }, { version: 1, language: "en-US" }],
			[
				"permissions",
				{ version: 1, permissions: [{ origin: "https://a", permission: "media", allowed: true }] },
				{ version: 1, permissions: [{ origin: "https://a", permission: "media", allowed: false }] },
			],
		];
		for (const [id, left, right] of pairs) {
			const l = JSON.stringify(left);
			const r = JSON.stringify(right);
			expect(mergeBrowserText(id, l, r)).toBe(mergeBrowserText(id, r, l));
		}
		const permissions = JSON.parse(
			mergeBrowserText("permissions", JSON.stringify(pairs[3]![1]), JSON.stringify(pairs[3]![2]))!,
		);
		expect(permissions.permissions[0].allowed).toBe(false);
		expect(mergeBrowserText("vault-0123456789abcdef", "{}", "{}")).toBeUndefined();
		expect(mergeBrowserText("../settings", "{}", "{}")).toBeUndefined();
	});
});

describe("record merge", () => {
	it("gives the same result whichever computer is local, and keeps what each side added", () => {
		for (const [left, right] of [
			["a\nx\nb", "a\ny\nb"],
			["one\ntwo", "two\none"],
			["same", "same\nmore"],
		] as const) {
			expect(mergeText(undefined, left, right)).toBe(mergeText(undefined, right, left));
		}
		expect(mergeText(undefined, "a\nx\nb", "a\ny\nb").split("\n").sort()).toEqual(["a", "b", "x", "y"]);

		const draft = (text: string, ids: string[]) =>
			JSON.stringify({ text, attachments: ids.map((id) => ({ id, name: `${id}.png` })) });
		const base = draft("Plan:", ["f0"]);
		const merged = mergeDraft(base, draft("Plan:\n- here", ["f0", "f1"]), draft("Plan:\n- there", ["f0", "f2"]));
		expect(merged).toBe(
			mergeDraft(base, draft("Plan:\n- there", ["f0", "f2"]), draft("Plan:\n- here", ["f0", "f1"])),
		);
		expect(
			JSON.parse(merged!)
				.attachments.map((file: { id: string }) => file.id)
				.sort(),
		).toEqual(["f0", "f1", "f2"]);
		expect(mergeDraft(undefined, "not json", draft("x", []))).toBeUndefined();

		const prompts = (...titles: string[]) =>
			JSON.stringify(titles.map((title) => ({ title, text: `${title} text` })));
		expect(mergeSavedPrompts(prompts("A"), prompts("A", "B"), prompts("A", "C"))).toBe(
			mergeSavedPrompts(prompts("A"), prompts("A", "C"), prompts("A", "B")),
		);

		const crlf = new TextEncoder().encode("x\r\ny\r\n");
		const lf = new TextEncoder().encode("x\nz\n");
		expect(mergeTextFile("notes/plan.md", crlf, lf)).toEqual(mergeTextFile("notes/plan.md", lf, crlf));
		expect(mergeTextFile("artifacts/chart.png", crlf, lf)).toBeUndefined();
		expect(mergeTextFile("notes/plan.md", new Uint8Array([0xff, 0xfe, 0x00]), lf)).toBeUndefined();

		const summary = (coveredCount: number) => JSON.stringify({ summary: `${coveredCount}`, coveredCount });
		expect(pickHandoff(summary(3), summary(5))).toBe(summary(5));
		expect(pickHandoff(summary(5), summary(3))).toBe(summary(5));

		const older = { updatedAt: "2026-01-01T00:00:00.000Z", hash: "b" };
		const newer = { updatedAt: "2026-01-02T00:00:00.000Z", hash: "a" };
		expect(newerFileVersion(older, newer)).toBe("remote");
		expect(newerFileVersion(newer, older)).toBe("local");

		const metadata = (cwd: string, updatedAt: string) =>
			JSON.stringify({ version: 1, sessionId: "s1", cwd, updatedAt, conversationPath: `${cwd}\\chat.jsonl` });
		const here = sessionMetadataFile(
			metadata("C:\\a", "2026-01-02Z"),
			metadata("D:\\b", "2026-01-03Z"),
			true,
			() => undefined,
		);
		const there = sessionMetadataFile(
			metadata("D:\\b", "2026-01-03Z"),
			metadata("C:\\a", "2026-01-02Z"),
			true,
			() => undefined,
		);
		expect(here!.portable).toBe(there!.portable);
		expect(JSON.parse(here!.file)).toMatchObject({ cwd: "C:\\a", updatedAt: "2026-01-03Z" });
		expect(JSON.parse(there!.file)).toMatchObject({ cwd: "D:\\b", updatedAt: "2026-01-03Z" });
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

	/** A service with no client of its own on this device, whatever the environment sets. */
	function signInService(builtInApp: () => { clientId: string; clientSecret?: string } | undefined): SyncService {
		vi.stubEnv("MYHARNESS_GOOGLE_CLIENT_ID", "");
		vi.stubEnv("MYHARNESS_GOOGLE_CLIENT_SECRET", "");
		const root = mkdtempSync(join(tmpdir(), "myharness-sync-sign-in-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const dataRoot = join(root, "data");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(dataRoot, { recursive: true });
		return SyncService.create({ agentDir, dataRoot, builtInApp, openExternal: () => {} });
	}

	/** Plays the browser for a sign-in the user refuses; returns its authorization URL once the service stopped waiting. */
	async function refuseSignIn(service: SyncService): Promise<URL> {
		const authorize = new URL((await service.connect()).authUrl);
		const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
		redirect.search = new URLSearchParams({
			error: "access_denied",
			state: authorize.searchParams.get("state")!,
		}).toString();
		await fetch(redirect);
		for (let i = 0; i < 200 && service.status().phase === "authorizing"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(service.status().phase).not.toBe("authorizing");
		return authorize;
	}

	it("signs in with MyHarness's own app until this device sets a client of its own", async () => {
		const service = signInService(() => ({
			clientId: "builtin-client.apps.googleusercontent.com",
			clientSecret: "test-builtin",
		}));
		try {
			expect(service.status()).toMatchObject({ builtInClient: true, clientConfigured: false, connected: false });
			const builtIn = await refuseSignIn(service);
			expect(builtIn.searchParams.get("client_id")).toBe("builtin-client.apps.googleusercontent.com");
			expect(builtIn.searchParams.get("scope")?.split(" ")).toEqual(
				expect.arrayContaining(["openid", "email", "https://www.googleapis.com/auth/drive.file"]),
			);

			await service.updateConfig({ clientId: "own-client.apps.googleusercontent.com", clientSecret: "test-own" });
			const own = await refuseSignIn(service);
			expect(own.searchParams.get("client_id")).toBe("own-client.apps.googleusercontent.com");
		} finally {
			await service.dispose();
			vi.unstubAllEnvs();
		}
	});

	it("asks for a client of the user's own when the build ships no app", async () => {
		const service = signInService(() => undefined);
		try {
			expect(service.status().builtInClient).toBe(false);
			await expect(service.connect()).rejects.toThrow("client id");
		} finally {
			await service.dispose();
			vi.unstubAllEnvs();
		}
	});
});
