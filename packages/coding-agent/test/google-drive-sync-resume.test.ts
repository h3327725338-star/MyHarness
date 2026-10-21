import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "../src/sync/engine.ts";
import { SyncLocalStore } from "../src/sync/store.ts";
import type { DrivePort, RemoteFile, RemoteFolder } from "../src/sync/types.ts";

// Lets one test make applying a memory fail the way a full disk does, without touching the real disk.
const applyFailure: { code?: string } = {};
vi.mock("../src/sync/apply.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/sync/apply.ts")>();
	return {
		...original,
		applyMemory: (...args: Parameters<typeof original.applyMemory>) => {
			if (applyFailure.code) {
				const error = new Error(`${applyFailure.code}: simulated`) as NodeJS.ErrnoException;
				error.code = applyFailure.code;
				return Promise.reject(error);
			}
			return original.applyMemory(...args);
		},
	};
});

/** In-memory Drive that can fail like a real network, or "crash" right after Drive accepted a manifest. */
class FakeDrive implements DrivePort {
	readonly folders = new Map<string, Map<string, Uint8Array>>();
	objectUploads = 0;
	offline = false;
	failBatchReads = false;
	/** Store the manifest, then throw: the process died before it learned the write succeeded. */
	crashAfterManifest = false;
	/** Throw before storing the manifest: the request never reached Drive. */
	failBeforeManifest = false;

	constructor() {
		for (const name of ["root", "batches", "objects", "snapshots"]) this.folders.set(name, new Map());
	}

	private check(): void {
		if (this.offline) throw new Error("fetch failed");
	}

	list(folder: RemoteFolder): Promise<RemoteFile[]> {
		this.check();
		const entries = [...(this.folders.get(folder)?.entries() ?? [])].map(([name, data]) => ({
			id: `file-${name}`,
			name,
			size: data.byteLength,
		}));
		return Promise.resolve(entries.sort((a, b) => a.name.localeCompare(b.name)));
	}

	read(folder: RemoteFolder, name: string): Promise<Uint8Array | undefined> {
		this.check();
		if (folder === "batches" && this.failBatchReads) return Promise.reject(new Error("socket hang up"));
		return Promise.resolve(this.folders.get(folder)?.get(name));
	}

	write(folder: RemoteFolder, name: string, data: Uint8Array): Promise<RemoteFile> {
		this.check();
		if (folder === "batches" && this.failBeforeManifest) return Promise.reject(new Error("fetch failed"));
		this.folders.get(folder)!.set(name, data);
		if (folder === "batches" && this.crashAfterManifest) return Promise.reject(new Error("process stopped"));
		return Promise.resolve({ id: `file-${name}`, name, size: data.byteLength });
	}

	uploadObject(hash: string, data: Uint8Array): Promise<void> {
		this.check();
		const objects = this.folders.get("objects")!;
		if (!objects.has(hash)) {
			objects.set(hash, data);
			this.objectUploads += 1;
		}
		return Promise.resolve();
	}

	downloadObject(hash: string): Promise<Uint8Array | undefined> {
		return this.read("objects", hash);
	}

	ensureSpace(): Promise<{ folderId: string; folderName: string; syncId: string; url: string }> {
		this.check();
		return Promise.resolve({ folderId: "folder-1", folderName: "MyHarness", syncId: "space-1", url: "https://x" });
	}

	batchNames(): string[] {
		return [...this.folders.get("batches")!.keys()].sort();
	}
}

interface Device {
	agentDir: string;
	dataRoot: string;
	store: SyncLocalStore;
	engine: SyncEngine;
}

const roots: string[] = [];

function engineFor(drive: FakeDrive, agentDir: string, dataRoot: string, deviceId: string): SyncEngine {
	const engine = new SyncEngine({
		agentDir,
		dataRoot,
		deviceId,
		deviceName: deviceId,
		store: new SyncLocalStore(agentDir),
		accountKey: "account-1",
	});
	engine.setDrive(drive);
	return engine;
}

function device(drive: FakeDrive, deviceId: string): Device {
	const root = mkdtempSync(join(tmpdir(), `myharness-sync-resume-${deviceId}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const dataRoot = join(root, "data");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataRoot, { recursive: true });
	const store = new SyncLocalStore(agentDir);
	return { agentDir, dataRoot, store, engine: engineFor(drive, agentDir, dataRoot, deviceId) };
}

/** A new engine over the same files: what the next start after closing the app or a power cut sees. */
function restart(drive: FakeDrive, item: Device, deviceId: string): Device {
	return { ...item, engine: engineFor(drive, item.agentDir, item.dataRoot, deviceId) };
}

function writeMemory(dataRoot: string, name: string, text: string): void {
	const memory = join(dataRoot, "memory");
	mkdirSync(memory, { recursive: true });
	writeFileSync(
		join(memory, `${name}.md`),
		`---\nid: global/${name}\nname: ${name}\ndescription: shared\ntype: user\nscope: global\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n${text}\n`,
	);
}

function writeArtifacts(dataRoot: string, count: number): void {
	const metadata = join(dataRoot, "workspaces", "ws1", "metadata");
	mkdirSync(metadata, { recursive: true });
	writeFileSync(
		join(metadata, "workspace.json"),
		JSON.stringify({
			version: 2,
			workspace: {
				workspaceId: "ws1",
				id: "ws1",
				modes: ["general"],
				name: "Study",
				rootPath: join(dataRoot, "workspace-folders", "study"),
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		}),
	);
	const folder = join(dataRoot, "workspaces", "ws1", "artifacts");
	mkdirSync(folder, { recursive: true });
	for (let index = 0; index < count; index += 1) writeFileSync(join(folder, `note-${index}.txt`), `body ${index}`);
}

afterEach(() => {
	applyFailure.code = undefined;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Google Drive sync resume", () => {
	it("commits a manifest Drive accepted just before the app stopped, without publishing or uploading it again", async () => {
		const drive = new FakeDrive();
		let a = device(drive, "device-a");
		writeMemory(a.dataRoot, "profile", "keep me");
		drive.crashAfterManifest = true;
		await a.engine.runOnce();
		expect(a.engine.status().phase).toBe("error");
		expect(drive.batchNames()).toHaveLength(1);
		expect(a.store.state("account-1").publishing?.batchFile).toBe(drive.batchNames()[0]);

		drive.crashAfterManifest = false;
		a = restart(drive, a, "device-a");
		await a.engine.runOnce();

		expect(drive.batchNames()).toHaveLength(1);
		expect(drive.objectUploads).toBe(1);
		expect(a.store.state("account-1").publishing).toBeUndefined();
		expect(a.engine.status().pendingUploads).toBe(0);
		expect(a.engine.status().phase).toBe("idle");
	});

	it("publishes again after a manifest that never reached Drive, reusing the objects already uploaded", async () => {
		const drive = new FakeDrive();
		let a = device(drive, "device-a");
		const b = device(drive, "device-b");
		writeArtifacts(a.dataRoot, 3);
		drive.failBeforeManifest = true;
		await a.engine.runOnce();
		expect(drive.batchNames()).toHaveLength(0);
		const uploaded = drive.objectUploads;
		expect(uploaded).toBeGreaterThan(0);

		drive.failBeforeManifest = false;
		a = restart(drive, a, "device-a");
		await a.engine.runOnce();
		expect(drive.batchNames()).toHaveLength(1);
		expect(drive.objectUploads).toBe(uploaded);

		await b.engine.runOnce();
		expect(readdirSync(join(b.dataRoot, "workspaces", "ws1", "artifacts"))).toHaveLength(3);
	});

	it("resumes a large upload after the last published batch instead of starting over", async () => {
		const drive = new FakeDrive();
		let a = device(drive, "device-a");
		writeArtifacts(a.dataRoot, 1200);
		let manifests = 0;
		const write = drive.write.bind(drive);
		drive.write = (folder, name, data) => {
			if (folder === "batches" && ++manifests === 2) return Promise.reject(new Error("fetch failed"));
			return write(folder, name, data);
		};
		await a.engine.runOnce();
		expect(drive.batchNames()).toHaveLength(1);
		const uploadsBefore = drive.objectUploads;

		a = restart(drive, a, "device-a");
		await a.engine.runOnce();
		// 1200 artifacts + the workspace record: three batches, the first one not repeated.
		expect(drive.batchNames()).toHaveLength(3);
		expect(drive.objectUploads).toBeLessThanOrEqual(1201);
		expect(drive.objectUploads).toBeGreaterThanOrEqual(uploadsBefore);
		expect(a.engine.status().pendingUploads).toBe(0);
	});

	it("keeps local changes waiting while offline and uploads them on its own once the network is back", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "device-a");
		writeMemory(a.dataRoot, "profile", "offline edit");
		drive.offline = true;
		await a.engine.runOnce();
		expect(a.engine.status().phase).toBe("error");
		expect(a.engine.status().lastError).toContain("fetch failed");
		expect(a.engine.status().pendingUploads).toBe(1);
		expect(drive.batchNames()).toHaveLength(0);
		expect(a.store.state("account-1").entities).toEqual({});

		drive.offline = false;
		await a.engine.runOnce();
		expect(drive.batchNames()).toHaveLength(1);
		expect(a.engine.status().lastError).toBeNull();
	});

	it("still uploads local changes when downloading keeps failing", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "device-a");
		const b = device(drive, "device-b");
		writeMemory(b.dataRoot, "remote", "from b");
		await b.engine.runOnce();
		writeMemory(a.dataRoot, "profile", "from a");
		drive.failBatchReads = true;

		await a.engine.runOnce();
		expect(a.engine.status().phase).toBe("error");
		expect(drive.batchNames()).toHaveLength(2);
		expect(existsSync(join(a.dataRoot, "memory", "remote.md"))).toBe(false);

		drive.failBatchReads = false;
		await a.engine.runOnce();
		expect(readFileSync(join(a.dataRoot, "memory", "remote.md"), "utf8")).toContain("from b");
		expect(a.engine.status().pendingDownloads).toBe(0);
	});

	it("keeps a batch waiting to download when the disk is full instead of marking it applied", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "device-a");
		const b = device(drive, "device-b");
		writeMemory(b.dataRoot, "remote", "from b");
		await b.engine.runOnce();

		applyFailure.code = "ENOSPC";
		await a.engine.runOnce();
		expect(a.engine.status().phase).toBe("error");
		expect(a.engine.status().lastError).toContain("ENOSPC");
		expect(a.engine.status().pendingDownloads).toBe(1);
		expect(a.engine.status().issues).toHaveLength(0);
		expect(a.store.state("account-1").appliedBatches).not.toContain(drive.batchNames()[0]);

		applyFailure.code = undefined;
		await a.engine.runOnce();
		expect(readFileSync(join(a.dataRoot, "memory", "remote.md"), "utf8")).toContain("from b");
		expect(a.engine.status().pendingDownloads).toBe(0);
	});
});

describe("manual Download now / Sync now", () => {
	it("downloads everything without uploading, including batches that arrive during the run", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "device-a");
		const b = device(drive, "device-b");
		writeArtifacts(b.dataRoot, 1200);
		await b.engine.runOnce();
		writeMemory(a.dataRoot, "local", "not yet");

		// Another device publishes while this download is running.
		let injected = false;
		const list = drive.list.bind(drive);
		drive.list = async (folder) => {
			const result = await list(folder);
			if (folder === "batches" && !injected) {
				injected = true;
				writeMemory(b.dataRoot, "late", "arrived later");
				await b.engine.runOnce();
			}
			return result;
		};

		await a.engine.runManual("download");
		const manual = a.engine.status().manual;
		expect(manual?.state).toBe("done");
		expect(manual?.total).toBe(manual?.done);
		expect(readdirSync(join(a.dataRoot, "workspaces", "ws1", "artifacts"))).toHaveLength(1200);
		expect(readFileSync(join(a.dataRoot, "memory", "late.md"), "utf8")).toContain("arrived later");
		expect(a.engine.status().pendingDownloads).toBe(0);
		// Download only: the local memory is still waiting to upload.
		expect(drive.batchNames().some((name) => name.startsWith("device-a-"))).toBe(false);
	});

	it("retries a batch that was skipped for a missing object once the object is there", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "device-a");
		const b = device(drive, "device-b");
		writeMemory(b.dataRoot, "remote", "from b");
		await b.engine.runOnce();
		const objects = drive.folders.get("objects")!;
		const [hash, data] = [...objects.entries()][0]!;
		objects.delete(hash);
		for (let pass = 0; pass < 7; pass += 1) await a.engine.runOnce();
		expect(a.engine.status().issues.some((issue) => issue.reason === "missing-object")).toBe(true);

		objects.set(hash, data);
		await a.engine.runManual("download");
		expect(readFileSync(join(a.dataRoot, "memory", "remote.md"), "utf8")).toContain("from b");
		expect(a.engine.status().issues).toHaveLength(0);
	});

	it("syncs both ways and waits for a pass that is already running", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "device-a");
		const b = device(drive, "device-b");
		writeMemory(b.dataRoot, "remote", "from b");
		await b.engine.runOnce();
		writeMemory(a.dataRoot, "local", "from a");

		const background = a.engine.runOnce();
		await a.engine.runManual("sync");
		await background;
		expect(a.engine.status().manual?.state).toBe("done");
		expect(readFileSync(join(a.dataRoot, "memory", "remote.md"), "utf8")).toContain("from b");
		await b.engine.runOnce();
		expect(readFileSync(join(b.dataRoot, "memory", "local.md"), "utf8")).toContain("from a");
	});

	it("refuses to run while sync is paused", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "device-a");
		writeMemory(a.dataRoot, "local", "stay here");
		await a.engine.updateConfig({ enabled: true, paused: true });
		await expect(a.engine.runManual("sync")).rejects.toThrow(/paused/i);
		await expect(a.engine.runManual("download")).rejects.toThrow(/paused/i);
		expect(drive.batchNames()).toHaveLength(0);
	});
});
