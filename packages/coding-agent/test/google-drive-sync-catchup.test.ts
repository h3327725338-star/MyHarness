import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "../src/sync/engine.ts";
import { GoogleDriveClient } from "../src/sync/google.ts";
import { SyncLocalStore } from "../src/sync/store.ts";
import type {
	DrivePort,
	RemoteFile,
	RemoteFolder,
	SyncEngineOptions,
	SyncOperation,
	SyncProgress,
	SyncSnapshot,
} from "../src/sync/types.ts";

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);
const BASE_TIME = Date.UTC(2026, 9, 1);

interface StoredFile {
	data: Uint8Array;
	createdTime: string;
}

/**
 * One Drive shared by every device of a test. It keeps creation times (so listings can be incremental), can fail or
 * hide chosen files, and records which device asked for what through its per-device views.
 */
class SharedDrive {
	readonly folders = new Map<string, Map<string, StoredFile>>();
	readonly hiddenObjects = new Set<string>();
	readonly failingReads = new Set<string>();
	readonly reads: { device: string; folder: RemoteFolder; name: string }[] = [];
	readonly lists: { device: string; folder: RemoteFolder; createdAfter?: string }[] = [];
	readonly located: { device: string; hashes: string[] }[] = [];
	private clock = BASE_TIME;

	constructor() {
		for (const name of ["root", "batches", "objects", "snapshots", "files"]) this.folders.set(name, new Map());
	}

	store(folder: RemoteFolder, name: string, data: Uint8Array): void {
		this.clock += 1000;
		this.folders.get(folder)!.set(name, { data, createdTime: new Date(this.clock).toISOString() });
	}

	view(device: string): DrivePort {
		return {
			ensureSpace: () => {
				if (!this.folders.get("root")!.has("identity.json"))
					this.store(
						"root",
						"identity.json",
						bytes(JSON.stringify({ version: 1, syncId: "space-1", createdAt: "x" })),
					);
				return Promise.resolve({ folderId: "folder-1", folderName: "MyHarness", syncId: "space-1", url: "u" });
			},
			list: (folder, options = {}) => {
				this.lists.push({
					device,
					folder,
					...(options.createdAfter ? { createdAfter: options.createdAfter } : {}),
				});
				const after = options.createdAfter;
				const files: RemoteFile[] = [...this.folders.get(folder)!.entries()]
					.filter(([, file]) => !after || file.createdTime > after)
					.map(([name, file]) => ({
						id: `file-${name}`,
						name,
						size: file.data.byteLength,
						createdTime: file.createdTime,
					}));
				return Promise.resolve(files.sort((a, b) => a.name.localeCompare(b.name)));
			},
			read: (folder, name) => {
				this.reads.push({ device, folder, name });
				if (this.failingReads.has(name)) return Promise.reject(new Error("Drive did not answer"));
				if (folder === "objects" && this.hiddenObjects.has(name)) return Promise.resolve(undefined);
				return Promise.resolve(this.folders.get(folder)?.get(name)?.data);
			},
			write: (folder, name, data) => {
				this.store(folder, name, data);
				return Promise.resolve({ id: `file-${name}`, name, size: data.byteLength });
			},
			uploadObject: (hash, data) => {
				if (!this.folders.get("objects")!.has(hash)) this.store("objects", hash, data);
				return Promise.resolve();
			},
			downloadObject: (hash) => {
				this.reads.push({ device, folder: "objects", name: hash });
				if (this.hiddenObjects.has(hash)) return Promise.resolve(undefined);
				return Promise.resolve(this.folders.get("objects")!.get(hash)?.data);
			},
			locateObjects: (hashes) => {
				this.located.push({ device, hashes: [...hashes] });
				return Promise.resolve();
			},
		};
	}

	locatedBy(device: string): string[][] {
		return this.located.filter((item) => item.device === device).map((item) => item.hashes);
	}

	readsBy(device: string, folder: RemoteFolder): string[] {
		return this.reads.filter((read) => read.device === device && read.folder === folder).map((read) => read.name);
	}

	/** Publish a batch the way another computer would, at a chosen batch time. */
	addBatch(deviceId: string, time: number, operations: SyncOperation[]): string {
		const name = `${deviceId}-${time.toString(36)}-${sha(`${deviceId}:${time}`).slice(0, 8)}.json`;
		const batch = {
			version: 1,
			batchId: name.slice(0, -".json".length),
			deviceId,
			deviceName: deviceId,
			createdAt: new Date(time).toISOString(),
			operations,
		};
		this.store("batches", name, bytes(JSON.stringify(batch)));
		return name;
	}

	/** A file record of another computer, its content uploaded as an object. */
	fileOp(id: string, content: string, device: string, counter: number): SyncOperation {
		const data = bytes(content);
		const hash = sha(data);
		if (!this.folders.get("objects")!.has(hash)) this.store("objects", hash, data);
		return {
			op: "put",
			key: `file:${id}`,
			kind: "file",
			id,
			hash,
			size: data.byteLength,
			vector: { [device]: counter },
			updatedAt: new Date(BASE_TIME + counter * 1000).toISOString(),
		};
	}
}

interface Device {
	agentDir: string;
	dataRoot: string;
	engine: SyncEngine;
	store: SyncLocalStore;
	progress: SyncProgress[];
}

const roots: string[] = [];

function device(drive: SharedDrive, name: string, deviceId: string, options: Partial<SyncEngineOptions> = {}): Device {
	const root = mkdtempSync(join(tmpdir(), `myharness-catchup-${name}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const dataRoot = join(root, "data");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataRoot, { recursive: true });
	const store = new SyncLocalStore(agentDir);
	const progress: SyncProgress[] = [];
	const engine = new SyncEngine({
		agentDir,
		dataRoot,
		deviceId,
		deviceName: name,
		store,
		accountKey: "account-1",
		onStatus: (status) => {
			if (status.progress) progress.push(status.progress);
		},
		...options,
	});
	engine.setDrive(drive.view(deviceId));
	return { agentDir, dataRoot, engine, store, progress };
}

function writeWorkspace(root: string, workspaceId = "ws1"): void {
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
				rootPath: join(root, "workspace-folders", "study"),
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		}),
	);
}

function writeSession(root: string, sessionId = "s1"): string {
	writeWorkspace(root);
	const conversation = join(root, "workspaces", "ws1", "sessions", sessionId, "conversation");
	mkdirSync(conversation, { recursive: true });
	const file = join(conversation, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		mode: "general",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: join(root, "workspace-folders", "study"),
		workspaceId: "ws1",
	};
	writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry("e1", "hello"))}\n`);
	return file;
}

function entry(id: string, text: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function writeUpload(root: string, name: string, text: string): string {
	writeWorkspace(root);
	const file = join(root, "workspaces", "ws1", "uploads", name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	return file;
}

function writeMemory(root: string, text: string): void {
	mkdirSync(join(root, "memory"), { recursive: true });
	writeFileSync(
		join(root, "memory", "profile.md"),
		`---\nid: global/profile\nname: Profile\ndescription: shared\ntype: user\nscope: global\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n${text}\n`,
	);
}

afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Google Drive sync catch-up", () => {
	it("applies only the newest version of each record and never touches another computer's writer locks", async () => {
		const drive = new SharedDrive();
		const lock = "workspaces/ws1/sessions/s1/conversation/2026_s1.jsonl.lock.owner";
		const note = "workspaces/ws1/uploads/note.txt";
		let version = 0;
		// What an older version published: a chat's writer-lock marker every 30 seconds, a real file now and then.
		for (let index = 1; index <= 3000; index += 1) {
			const operations = [drive.fileOp(lock, JSON.stringify({ pid: 4242, lockMtimeMs: index }), "device-x", index)];
			if (index % 100 === 0) {
				version += 1;
				operations.push(drive.fileOp(note, `note version ${version}`, "device-x", version));
			}
			drive.addBatch("device-x", BASE_TIME + index * 1000, operations);
		}
		const b = device(drive, "laptop", "device-b");
		// The workspace is a General one here too (its record would have arrived with the files).
		writeWorkspace(b.dataRoot);
		// This computer's own open chat: a deletion of the marker published elsewhere must not remove it.
		const ownLock = join(b.dataRoot, lock);
		mkdirSync(dirname(ownLock), { recursive: true });
		writeFileSync(ownLock, "mine");
		drive.addBatch("device-x", BASE_TIME + 3001 * 1000, [
			{
				op: "delete",
				key: `file:${lock}`,
				kind: "file",
				id: lock,
				hash: "",
				size: 0,
				vector: { "device-x": 3001 },
				updatedAt: new Date(BASE_TIME).toISOString(),
				deletedAt: new Date(BASE_TIME).toISOString(),
			},
		]);
		let saves = 0;
		const save = b.store.saveState.bind(b.store);
		b.store.saveState = (state) => {
			saves += 1;
			save(state);
		};

		await b.engine.runOnce();

		expect(readFileSync(join(b.dataRoot, note), "utf8")).toBe("note version 30");
		expect(readFileSync(ownLock, "utf8")).toBe("mine");
		// One download: the newest note. None of the 3000 lock markers, none of the 29 older notes.
		expect(drive.readsBy("device-b", "objects")).toHaveLength(1);
		// Its place in Drive was asked for ahead of the download, and nothing else was.
		expect(drive.locatedBy("device-b")).toEqual([[sha("note version 30")]]);
		const status = b.engine.status();
		expect(status.pendingDownloads).toBe(0);
		expect(status.issues).toEqual([]);
		expect(status.phase).toBe("idle");
		// The state is written about once a second, not once per batch or change.
		expect(saves).toBeLessThan(40);
		// Every batch is handled: the next pass reads no change list again.
		const read = drive.readsBy("device-b", "batches").length;
		expect(read).toBe(3001);
		await b.engine.runOnce();
		expect(drive.readsBy("device-b", "batches")).toHaveLength(read);
		expect(b.store.state("account-1").appliedBatches).toHaveLength(0);
	}, 60_000);

	it("catches a new computer up from the other one's snapshot without reading its batches", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-20T08:00:00.000Z"));
		const drive = new SharedDrive();
		const a = device(drive, "desktop", "device-a");
		writeMemory(a.dataRoot, "remember this");
		writeSession(a.dataRoot);
		const large = "x".repeat(100 * 1024);
		writeUpload(a.dataRoot, "big.txt", large);
		for (let index = 0; index < 25; index += 1) {
			writeUpload(a.dataRoot, "note.txt", `note ${index}`);
			vi.setSystemTime(Date.now() + 1000);
			await a.engine.runOnce();
		}
		// The first snapshot went up with the first pass; a fresh one follows once it is old enough.
		vi.setSystemTime(Date.now() + 11 * 60_000);
		writeUpload(a.dataRoot, "note.txt", "final note");
		await a.engine.runOnce();
		const stored = drive.folders.get("snapshots")!.get("device-a.json.gz");
		expect(stored).toBeDefined();
		const snapshot = JSON.parse(gunzipSync(stored!.data).toString("utf8")) as SyncSnapshot;
		const own = drive.folders.get("batches")!;
		const newest = Math.max(...[...own.keys()].map((name) => Number.parseInt(name.split("-").at(-2)!, 36)));
		expect(Number.parseInt(snapshot.upTo, 36)).toBe(newest);
		expect(own.size).toBe(26);

		const b = device(drive, "laptop", "device-b");
		await b.engine.runOnce();

		expect(drive.readsBy("device-b", "batches")).toEqual([]);
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "note.txt"), "utf8")).toBe("final note");
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "big.txt"), "utf8")).toBe(large);
		expect(readFileSync(join(b.dataRoot, "memory", "profile.md"), "utf8")).toContain("remember this");
		const conversation = join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "conversation");
		expect(readdirSync(conversation).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
		// Only the content too large to travel inside the snapshot was downloaded.
		expect(drive.readsBy("device-b", "objects")).toEqual([sha(large)]);
		expect(drive.locatedBy("device-b")).toEqual([[sha(large)]]);
		const state = b.store.state("account-1");
		expect(state.appliedUpTo?.["device-a"]).toBe(snapshot.upTo);
		expect(b.engine.status().pendingDownloads).toBe(0);
		expect(b.engine.status().conflicts).toEqual([]);

		// Later batches of that device are read one by one again.
		writeUpload(a.dataRoot, "note.txt", "after the snapshot");
		vi.setSystemTime(Date.now() + 1000);
		await a.engine.runOnce();
		await b.engine.runOnce();
		expect(drive.readsBy("device-b", "batches")).toHaveLength(1);
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "note.txt"), "utf8")).toBe(
			"after the snapshot",
		);
	}, 60_000);

	it("keeps a snapshot's backlog waiting while content is missing, then finishes it once the content arrives", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-20T08:00:00.000Z"));
		const drive = new SharedDrive();
		const a = device(drive, "desktop", "device-a");
		const large = "y".repeat(80 * 1024);
		writeUpload(a.dataRoot, "big.txt", large);
		for (let index = 0; index < 21; index += 1) {
			writeUpload(a.dataRoot, "note.txt", `note ${index}`);
			vi.setSystemTime(Date.now() + (index === 20 ? 11 * 60_000 : 1000));
			await a.engine.runOnce();
		}
		drive.hiddenObjects.add(sha(large));
		const b = device(drive, "laptop", "device-b");
		await b.engine.runOnce();
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "note.txt"), "utf8")).toBe("note 20");
		expect(existsSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "big.txt"))).toBe(false);
		expect(b.store.state("account-1").appliedUpTo?.["device-a"]).toBeUndefined();
		expect(b.engine.status().pendingDownloads).toBe(1);

		drive.hiddenObjects.clear();
		await b.engine.runOnce();
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "big.txt"), "utf8")).toBe(large);
		expect(b.store.state("account-1").appliedUpTo?.["device-a"]).toBeDefined();
		expect(b.engine.status().pendingDownloads).toBe(0);
		expect(drive.readsBy("device-b", "batches")).toEqual([]);
	}, 60_000);

	it("reads a device's batches instead of its snapshot when content the snapshot names never arrives", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-20T08:00:00.000Z"));
		const drive = new SharedDrive();
		const a = device(drive, "desktop", "device-a");
		const large = "z".repeat(80 * 1024);
		writeUpload(a.dataRoot, "big.txt", large);
		for (let index = 0; index < 21; index += 1) {
			writeUpload(a.dataRoot, "note.txt", `note ${index}`);
			vi.setSystemTime(Date.now() + (index === 20 ? 11 * 60_000 : 1000));
			await a.engine.runOnce();
		}
		drive.hiddenObjects.add(sha(large));
		const b = device(drive, "laptop", "device-b");
		for (let pass = 0; pass < 6; pass += 1) await b.engine.runOnce();
		expect(drive.readsBy("device-b", "batches")).toEqual([]);
		expect(b.engine.status().issues).toEqual([]);

		// Set aside: the batches are read, and only the one naming the missing file keeps waiting.
		await b.engine.runOnce();
		expect(drive.readsBy("device-b", "batches")).toHaveLength(21);
		expect(b.engine.status().pendingDownloads).toBe(1);
		for (let pass = 0; pass < 6; pass += 1) await b.engine.runOnce();
		const issues = b.engine.status().issues;
		expect(issues).toHaveLength(1);
		expect(issues[0]!.reason).toBe("missing-object");
		expect(b.store.state("account-1").appliedUpTo?.["device-a"]).toBeDefined();

		// A manual run gives that batch another chance once the file is there.
		drive.hiddenObjects.clear();
		await b.engine.runManual("download");
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "big.txt"), "utf8")).toBe(large);
		expect(b.engine.status().issues).toEqual([]);
	}, 60_000);

	it("keeps the changes of a chat running here waiting, without downloading them, however many passes it takes", async () => {
		const drive = new SharedDrive();
		const a = device(drive, "desktop", "device-a");
		let running = false;
		const b = device(drive, "laptop", "device-b", { isSessionActive: () => running });
		const file = writeSession(a.dataRoot);
		await a.engine.runOnce();
		await b.engine.runOnce();
		running = true;
		writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify(entry("e2", "second question"))}\n`);
		await a.engine.runOnce();
		const downloads = drive.readsBy("device-b", "objects").length;
		const manifests = drive.readsBy("device-b", "batches").length;

		for (let pass = 0; pass < 8; pass += 1) await b.engine.runOnce();

		expect(drive.readsBy("device-b", "objects")).toHaveLength(downloads);
		// The waiting change list is kept between passes instead of being read from Drive each time.
		expect(drive.readsBy("device-b", "batches")).toHaveLength(manifests + 1);
		expect(b.engine.status().issues).toEqual([]);
		expect(b.engine.status().pendingDownloads).toBe(1);

		running = false;
		await b.engine.runOnce();
		const conversation = join(b.dataRoot, "workspaces", "ws1", "sessions", "s1", "conversation");
		const [restored] = readdirSync(conversation).filter((name) => name.endsWith(".jsonl"));
		expect(readFileSync(join(conversation, restored!), "utf8")).toContain("second question");
		expect(b.engine.status().pendingDownloads).toBe(0);
	}, 60_000);

	it("applies the other batches when one change list cannot be read, and that one on the next pass", async () => {
		const drive = new SharedDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		writeUpload(a.dataRoot, "one.txt", "1");
		await a.engine.runOnce();
		writeUpload(a.dataRoot, "two.txt", "2");
		await a.engine.runOnce();
		const [first] = [...drive.folders.get("batches")!.keys()].sort();
		drive.failingReads.add(first!);

		await b.engine.runOnce();
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "two.txt"), "utf8")).toBe("2");
		expect(existsSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "one.txt"))).toBe(false);
		expect(b.engine.status().phase).toBe("idle");
		expect(b.engine.status().pendingDownloads).toBe(1);

		drive.failingReads.clear();
		await b.engine.runOnce();
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "one.txt"), "utf8")).toBe("1");
		expect(b.engine.status().pendingDownloads).toBe(0);
	});

	it("lists only what Drive created since the last listing, and everything again on a manual run", async () => {
		const drive = new SharedDrive();
		const a = device(drive, "desktop", "device-a");
		const b = device(drive, "laptop", "device-b");
		writeUpload(a.dataRoot, "one.txt", "1");
		await a.engine.runOnce();
		await b.engine.runOnce();
		writeUpload(a.dataRoot, "two.txt", "2");
		await a.engine.runOnce();
		await b.engine.runOnce();

		const listings = drive.lists.filter((item) => item.device === "device-b" && item.folder === "batches");
		expect(listings[0]!.createdAfter).toBeUndefined();
		expect(listings.at(-1)!.createdAfter).toBeDefined();
		expect(readFileSync(join(b.dataRoot, "workspaces", "ws1", "uploads", "two.txt"), "utf8")).toBe("2");

		await b.engine.runManual("download");
		const manual = drive.lists.filter((item) => item.device === "device-b" && item.folder === "batches");
		expect(manual[listings.length]!.createdAfter).toBeUndefined();
	});

	it("reports reading the change lists, then writing what they name", async () => {
		const drive = new SharedDrive();
		for (let index = 1; index <= 30; index += 1)
			drive.addBatch("device-x", BASE_TIME + index * 1000, [
				drive.fileOp(`workspaces/ws1/uploads/file-${index}.txt`, `file ${index}`, "device-x", index),
			]);
		const b = device(drive, "laptop", "device-b");
		writeWorkspace(b.dataRoot);
		await b.engine.runOnce();
		const read = b.progress.filter((item) => item.step === "read");
		const apply = b.progress.filter((item) => item.step === "apply");
		expect(read.length).toBeGreaterThan(0);
		expect(read.every((item) => item.stage === "download" && item.total === 30)).toBe(true);
		expect(apply.length).toBeGreaterThan(0);
		expect(apply.every((item) => item.total === 30 && item.done <= item.total)).toBe(true);
		for (const steps of [read, apply])
			for (let index = 1; index < steps.length; index += 1)
				expect(steps[index]!.done).toBeGreaterThanOrEqual(steps[index - 1]!.done);
		expect(b.engine.status().progress).toBeNull();
		expect(b.engine.status().pendingDownloads).toBe(0);
	});

	it("learns a newer version of content it already has without waiting for a download", async () => {
		const drive = new SharedDrive();
		const note = "workspaces/ws1/uploads/same.txt";
		const first = drive.fileOp(note, "same text", "device-x", 1);
		drive.addBatch("device-x", BASE_TIME + 1000, [first]);
		const b = device(drive, "laptop", "device-b");
		writeWorkspace(b.dataRoot);
		await b.engine.runOnce();
		// The same content republished under a newer version (a forced re-publish, a merge both sides reached).
		drive.hiddenObjects.add(first.hash);
		drive.addBatch("device-x", BASE_TIME + 2000, [{ ...first, vector: { "device-x": 2 } }]);

		await b.engine.runOnce();
		await b.engine.runOnce();

		const status = b.engine.status();
		expect(status.issues).toEqual([]);
		expect(status.pendingDownloads).toBe(0);
		expect(b.store.state("account-1").entities[`file:${note}`]?.vector).toEqual({ "device-x": 2 });
	});

	it("adopts a file that already holds the incoming version instead of reporting a conflict", async () => {
		const drive = new SharedDrive();
		const b = device(drive, "laptop", "device-b");
		writeUpload(b.dataRoot, "same.txt", "identical");
		const op = drive.fileOp("workspaces/ws1/uploads/same.txt", "identical", "device-x", 1);
		drive.addBatch("device-x", BASE_TIME + 1000, [op]);

		await b.engine.runOnce();

		expect(b.engine.status().conflicts).toEqual([]);
		expect(drive.readsBy("device-b", "objects")).toEqual([]);
		expect(b.store.state("account-1").entities[op.key]?.hash).toBe(op.hash);
	});
});

describe("Google Drive client", () => {
	const credentials = {
		version: 1 as const,
		clientId: "client",
		accessToken: "token",
		refreshToken: "refresh",
		expiresAt: Date.now() + 3_600_000,
		scope: "drive.file",
		obtainedAt: "2026-10-26T00:00:00.000Z",
	};

	function client(fetchImpl: (url: string) => Promise<Response>): GoogleDriveClient {
		const drive = new GoogleDriveClient({
			credentials,
			saveCredentials: () => {},
			fetchImpl: ((input: string | URL | Request) => fetchImpl(String(input))) as typeof fetch,
		});
		// The folder ids ensureSpace would have resolved.
		(drive as unknown as { folders: Record<string, string> }).folders = {
			objects: "objects-id",
			batches: "batches-id",
		};
		return drive;
	}

	it("retries Drive's 403 rate limit and looks several objects up in one query", async () => {
		const queries: string[] = [];
		let limited = 1;
		const drive = client(async (url) => {
			if (url.includes("/files?")) {
				queries.push(new URL(url).searchParams.get("q") ?? "");
				if (limited-- > 0)
					return new Response(
						JSON.stringify({ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }),
						{
							status: 403,
						},
					);
				const names = [...(queries.at(-1) ?? "").matchAll(/name='([^']+)'/gu)].map((match) => match[1]!);
				return new Response(JSON.stringify({ files: names.map((name) => ({ id: `id-${name}`, name })) }));
			}
			const id = /\/files\/([^?]+)\?alt=media/u.exec(url)?.[1];
			return new Response(`content of ${id}`);
		});

		const results = await Promise.all(["aa", "bb", "cc"].map((hash) => drive.downloadObject(hash)));

		expect(results.map((data) => new TextDecoder().decode(data))).toEqual([
			"content of id-aa",
			"content of id-bb",
			"content of id-cc",
		]);
		expect(queries).toHaveLength(2);
		expect(queries[1]).toContain("(name='aa' or name='bb' or name='cc')");
	}, 20_000);

	it("locates the objects of a round a few queries at a time, ahead of their downloads", async () => {
		const queries: string[] = [];
		let inFlight = 0;
		let most = 0;
		const drive = client(async (url) => {
			if (url.includes("/files?")) {
				const query = new URL(url).searchParams.get("q") ?? "";
				queries.push(query);
				inFlight += 1;
				most = Math.max(most, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 20));
				inFlight -= 1;
				const names = [...query.matchAll(/name='([^']+)'/gu)].map((match) => match[1]!);
				return new Response(JSON.stringify({ files: names.map((name) => ({ id: `id-${name}`, name })) }));
			}
			const id = /\/files\/([^?]+)\?alt=media/u.exec(url)?.[1];
			return new Response(`content of ${id}`);
		});
		const hashes = Array.from({ length: 120 }, (_, index) => `h${index}`);

		const locating = drive.locateObjects(hashes);
		// A download that starts while its name is on its way waits for that answer instead of asking again.
		const early = drive.downloadObject("h0");
		await locating;
		const data = await Promise.all([early, ...hashes.slice(1).map((hash) => drive.downloadObject(hash))]);

		expect(new TextDecoder().decode(data[0])).toBe("content of id-h0");
		expect(new TextDecoder().decode(data[119])).toBe("content of id-h119");
		// 120 names, 25 a query, never more than 4 queries at once, and no query of its own for any download.
		expect(queries).toHaveLength(5);
		expect(most).toBeLessThanOrEqual(4);
		expect(queries[0]).toContain("name='h0'");
	});

	it("does not retry a 403 that refuses permission", async () => {
		let calls = 0;
		const drive = client(async () => {
			calls += 1;
			return new Response(
				JSON.stringify({ error: { code: 403, errors: [{ reason: "insufficientFilePermissions" }] } }),
				{
					status: 403,
				},
			);
		});
		await expect(drive.list("batches")).rejects.toThrow();
		expect(calls).toBe(1);
	});

	it("lists only files created after a time when asked, with their creation times", async () => {
		const urls: string[] = [];
		const drive = client(async (url) => {
			urls.push(url);
			return new Response(
				JSON.stringify({ files: [{ id: "1", name: "b.json", createdTime: "2026-10-26T01:00:00.000Z" }] }),
			);
		});
		const files = await drive.list("batches", { createdAfter: "2026-10-26T00:50:00.000Z" });
		const params = new URL(urls[0]!).searchParams;
		expect(params.get("q")).toContain("createdTime > '2026-10-26T00:50:00.000Z'");
		expect(params.get("fields")).toContain("createdTime");
		expect(files[0]!.createdTime).toBe("2026-10-26T01:00:00.000Z");
	});
});
