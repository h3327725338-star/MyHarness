import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/data/workspace-store.ts";
import { applyWorkspaceFileManifest } from "../src/sync/files/apply.ts";
import { WorkspaceFileSync } from "../src/sync/files/engine.ts";
import { scanWorkspaceFiles } from "../src/sync/files/scan.ts";
import { WorkspaceFileStateStore } from "../src/sync/files/state.ts";
import type {
	WorkspaceFileManifest,
	WorkspaceFilePort,
	WorkspaceFileSource,
	WorkspaceFileState,
	WorkspaceUploadResume,
} from "../src/sync/files/types.ts";
import {
	discoverDriveRoots,
	findWorkspaceOccupancy,
	locateDriveFolder,
	releaseWorkspaceRoot,
} from "../src/sync/workspace-location.ts";

class FakePort implements WorkspaceFilePort {
	readonly manifests = new Map<string, Uint8Array>();
	readonly objects = new Map<string, Uint8Array>();
	readonly interrupted = new Set<string>();
	uploaded = 0;
	downloaded = 0;
	manifestWrites = 0;
	offline = false;

	ensureSpace(): Promise<void> {
		return Promise.resolve();
	}

	listManifests(): Promise<{ name: string; size?: number }[]> {
		return Promise.resolve(
			[...this.manifests.entries()]
				.map(([name, data]) => ({ name, size: data.byteLength }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		);
	}

	readManifest(name: string): Promise<Uint8Array | undefined> {
		return Promise.resolve(this.manifests.get(name));
	}

	writeManifest(name: string, data: Uint8Array): Promise<void> {
		if (this.offline) return Promise.reject(new Error("offline"));
		this.manifestWrites += 1;
		this.manifests.set(name, data);
		return Promise.resolve();
	}

	objectExists(hash: string): Promise<boolean> {
		return Promise.resolve(this.objects.has(hash));
	}

	uploadFile(
		hash: string,
		path: string,
		size: number,
		resume: WorkspaceUploadResume | undefined,
		onProgress?: (sent: number, sessionUri: string) => void,
	): Promise<void> {
		if (this.offline) return Promise.reject(new Error("offline"));
		const data = new Uint8Array(readFileSync(path));
		if (data.byteLength !== size) return Promise.reject(new Error("size changed"));
		onProgress?.(size, `session-${hash}`);
		this.objects.set(hash, data);
		this.uploaded += 1;
		return Promise.resolve(`${resume?.offset ?? 0}`).then(() => undefined);
	}

	downloadToFile(
		hash: string,
		tempPath: string,
		offset: number,
		onProgress?: (received: number) => void,
	): Promise<void> {
		if (this.offline) return Promise.reject(new Error("offline"));
		const data = this.objects.get(hash);
		if (!data) return Promise.reject(new Error("missing object"));
		const remaining = data.subarray(offset);
		if (this.interrupted.delete(hash)) {
			const half = Math.max(1, Math.floor(remaining.byteLength / 3));
			appendFileSync(tempPath, remaining.subarray(0, half));
			onProgress?.(offset + half);
			return Promise.reject(new Error("network interrupted"));
		}
		appendFileSync(tempPath, remaining);
		onProgress?.(data.byteLength);
		this.downloaded += 1;
		return Promise.resolve();
	}
}

interface Device {
	root: string;
	agentDir: string;
	dataRoot: string;
	workspaceRoot: string;
	engine: WorkspaceFileSync;
	store: WorkspaceStore;
	port: FakePort;
}

const roots: string[] = [];

function device(
	port: FakePort,
	name: string,
	deviceId: string,
	options: {
		workspaceId?: string;
		workspaceRoot?: string;
		/** Skip creating the folder, to act like a computer that has not bound one yet. */
		createRoot?: boolean;
		scanner?: typeof scanWorkspaceFiles;
	} = {},
): Device {
	const workspaceId = options.workspaceId ?? "ws1";
	const root = mkdtempSync(join(tmpdir(), `myharness-files-${name}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const dataRoot = join(root, "data");
	const workspaceRoot = options.workspaceRoot ?? join(root, "Study");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataRoot, { recursive: true });
	if (options.createRoot !== false) mkdirSync(workspaceRoot, { recursive: true });
	// Managed copies must never land in the real user profile during a test.
	process.env.MYHARNESS_WORKSPACE_FILES_ROOT = join(root, "managed");
	const store = WorkspaceStore.create(agentDir, dataRoot);
	store.importWorkspace({
		workspaceId,
		name: "Study",
		rootPath: workspaceRoot,
		modes: ["general"],
	});
	const engine = new WorkspaceFileSync({
		agentDir,
		dataRoot,
		deviceId,
		deviceName: name,
		accountKey: "account-1",
		port,
		manual: true,
		...(options.scanner ? { scanner: options.scanner } : {}),
		workspaceStore: () => WorkspaceStore.create(agentDir, dataRoot),
	});
	return { root, agentDir, dataRoot, workspaceRoot, engine, store, port };
}

async function enable(device: Device, source: WorkspaceFileSource = "local"): Promise<void> {
	const result = await device.engine.enableWorkspace("ws1", source, {
		confirmed: true,
		...(source === "drive" ? { driveRootId: "drive-1", driveRelativePath: "Study/OS" } : {}),
	});
	expect(result.ok).toBe(true);
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

const originalManagedRoot = process.env.MYHARNESS_WORKSPACE_FILES_ROOT;
const originalOneDrive = process.env.OneDrive;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalManagedRoot === undefined) delete process.env.MYHARNESS_WORKSPACE_FILES_ROOT;
	else process.env.MYHARNESS_WORKSPACE_FILES_ROOT = originalManagedRoot;
	if (originalOneDrive === undefined) delete process.env.OneDrive;
	else process.env.OneDrive = originalOneDrive;
});

describe("Workspace file sync channel", () => {
	it("uploads a first snapshot and rebuilds it into the second device's own folder", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		writeFileSync(join(a.workspaceRoot, "notes.txt"), "hello");
		mkdirSync(join(a.workspaceRoot, "empty"), { recursive: true });
		mkdirSync(join(a.workspaceRoot, "sub"), { recursive: true });
		writeFileSync(join(a.workspaceRoot, "sub", "deep.txt"), "deep");

		await enable(a);
		expect(port.manifestWrites).toBeGreaterThan(0);
		expect(port.uploaded).toBe(2);

		const b = device(port, "laptop", "device-b");
		await b.engine.runOnce();

		expect(readFileSync(join(b.workspaceRoot, "notes.txt"), "utf8")).toBe("hello");
		expect(readFileSync(join(b.workspaceRoot, "sub", "deep.txt"), "utf8")).toBe("deep");
		expect(existsSync(join(b.workspaceRoot, "empty"))).toBe(true);
		expect(b.store.getById("ws1")!.workspaceId).toBe("ws1");
		const status = b.engine.status();
		expect(status.workspaces.find((item) => item.workspaceId === "ws1")?.upToDate).toBe(true);
		expect(status.workspaces.find((item) => item.workspaceId === "ws1")?.message).toContain("云端版本");
	});

	it("propagates additions, edits and deletions in both directions", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		const b = device(port, "laptop", "device-b");
		writeFileSync(join(a.workspaceRoot, "one.txt"), "one");
		writeFileSync(join(a.workspaceRoot, "two.txt"), "two");
		await enable(a);
		await b.engine.runOnce();
		expect(readFileSync(join(b.workspaceRoot, "two.txt"), "utf8")).toBe("two");

		writeFileSync(join(a.workspaceRoot, "one.txt"), "one edited");
		writeFileSync(join(a.workspaceRoot, "three.txt"), "three");
		rmSync(join(a.workspaceRoot, "two.txt"));
		await a.engine.runOnce();
		await b.engine.runOnce();

		expect(readFileSync(join(b.workspaceRoot, "one.txt"), "utf8")).toBe("one edited");
		expect(readFileSync(join(b.workspaceRoot, "three.txt"), "utf8")).toBe("three");
		expect(existsSync(join(b.workspaceRoot, "two.txt"))).toBe(false);

		// And the other direction: a new file on the second device arrives on the first one.
		writeFileSync(join(b.workspaceRoot, "from-laptop.txt"), "laptop");
		await b.engine.runOnce();
		await a.engine.runOnce();
		expect(readFileSync(join(a.workspaceRoot, "from-laptop.txt"), "utf8")).toBe("laptop");
	});

	it("resumes an interrupted first download without reporting a false deletion", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		const body = new Uint8Array(3 * 1024 * 1024);
		for (let index = 0; index < body.byteLength; index += 1) body[index] = index % 251;
		writeFileSync(join(a.workspaceRoot, "big.bin"), body);
		await enable(a);
		const writesAfterBaseline = port.manifestWrites;

		const b = device(port, "laptop", "device-b");
		port.interrupted.add(sha256(body));
		await b.engine.runOnce();

		expect(existsSync(join(b.workspaceRoot, "big.bin"))).toBe(false);
		const waiting = b.engine.status().workspaces.find((item) => item.workspaceId === "ws1");
		expect(waiting?.upToDate).toBe(false);
		expect(port.manifestWrites).toBe(writesAfterBaseline);

		await b.engine.runOnce();
		expect(sha256(new Uint8Array(readFileSync(join(b.workspaceRoot, "big.bin"))))).toBe(sha256(body));
		expect(port.manifestWrites).toBe(writesAfterBaseline);
	});

	it("keeps both versions when both computers edit the same file", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		const b = device(port, "laptop", "device-b");
		writeFileSync(join(a.workspaceRoot, "shared.txt"), "base");
		await enable(a);
		await b.engine.runOnce();

		writeFileSync(join(a.workspaceRoot, "shared.txt"), "desktop version");
		writeFileSync(join(b.workspaceRoot, "shared.txt"), "laptop version");
		await a.engine.runOnce();
		await b.engine.runOnce();

		expect(readFileSync(join(b.workspaceRoot, "shared.txt"), "utf8")).toBe("laptop version");
		const conflicts = b.engine.status().conflicts;
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.reason).toBe("both-modified");
		expect(readFileSync(conflicts[0]!.remoteCopyPath!, "utf8")).toBe("desktop version");
		expect(b.engine.status().workspaces.find((item) => item.workspaceId === "ws1")?.upToDate).toBe(false);

		const result = await b.engine.resolveConflict("ws1", conflicts[0]!.id, "keep-local");
		expect(result.ok).toBe(true);
		await a.engine.runOnce();
		expect(readFileSync(join(a.workspaceRoot, "shared.txt"), "utf8")).toBe("laptop version");
		expect(b.engine.status().conflicts).toHaveLength(0);
	});

	it("never derives deletions from a subtree the scan could not read", async () => {
		const port = new FakePort();
		let hideSub = false;
		const scanner: typeof scanWorkspaceFiles = async (options) => {
			const result = await scanWorkspaceFiles(options);
			if (!hideSub) return result;
			for (const key of [...result.entries.keys()]) {
				if (key === "sub" || key.startsWith("sub/")) result.entries.delete(key);
			}
			result.incomplete = ["sub"];
			return result;
		};
		const root = mkdtempSync(join(tmpdir(), "myharness-files-scan-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const dataRoot = join(root, "data");
		const workspaceRoot = join(root, "Study");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(dataRoot, { recursive: true });
		mkdirSync(join(workspaceRoot, "sub"), { recursive: true });
		writeFileSync(join(workspaceRoot, "sub", "a.txt"), "inside");
		writeFileSync(join(workspaceRoot, "other.txt"), "outside");
		WorkspaceStore.create(agentDir, dataRoot).importWorkspace({
			workspaceId: "ws1",
			name: "Study",
			rootPath: workspaceRoot,
			modes: ["general"],
		});
		const a = new WorkspaceFileSync({
			agentDir,
			dataRoot,
			deviceId: "device-a",
			deviceName: "desktop",
			accountKey: "account-1",
			port,
			manual: true,
			scanner,
			workspaceStore: () => WorkspaceStore.create(agentDir, dataRoot),
		});
		await a.enableWorkspace("ws1", "local", { confirmed: true });

		const b = device(port, "laptop", "device-b");
		await b.engine.runOnce();
		expect(readFileSync(join(b.workspaceRoot, "sub", "a.txt"), "utf8")).toBe("inside");

		hideSub = true;
		rmSync(join(workspaceRoot, "sub"), { recursive: true, force: true });
		rmSync(join(workspaceRoot, "other.txt"));
		await a.runOnce();
		await b.engine.runOnce();

		// The unreadable subtree stays on both sides; the healthy file is deleted everywhere.
		expect(readFileSync(join(b.workspaceRoot, "sub", "a.txt"), "utf8")).toBe("inside");
		expect(existsSync(join(b.workspaceRoot, "other.txt"))).toBe(false);
		const status = a.status().workspaces.find((item) => item.workspaceId === "ws1");
		expect(status?.upToDate).toBe(false);
	});

	it("holds a bulk deletion until it is confirmed, then propagates it", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		for (let index = 0; index < 30; index += 1) {
			writeFileSync(join(a.workspaceRoot, `note-${index}.txt`), `body ${index}`);
		}
		await enable(a);
		const b = device(port, "laptop", "device-b");
		await b.engine.runOnce();
		const writesAfterBaseline = port.manifestWrites;

		for (let index = 0; index < 25; index += 1) rmSync(join(a.workspaceRoot, `note-${index}.txt`));
		await a.engine.runOnce();

		expect(port.manifestWrites).toBe(writesAfterBaseline);
		const blocked = a.engine.status().workspaces.find((item) => item.workspaceId === "ws1");
		expect(blocked?.state).toBe("blocked");
		expect(blocked?.upToDate).toBe(false);

		expect((await a.engine.confirmBulkDeletes("ws1")).ok).toBe(true);
		await b.engine.runOnce();
		expect(readdirSync(b.workspaceRoot).filter((name) => name.startsWith("note-"))).toHaveLength(5);
	});

	const itWindows = process.platform === "win32" ? it : it.skip;
	itWindows("turns a letter-case-only rename into a rename, not a conflict", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		const b = device(port, "laptop", "device-b");
		writeFileSync(join(a.workspaceRoot, "Report.txt"), "same body");
		await enable(a);
		await b.engine.runOnce();

		renameSync(join(a.workspaceRoot, "Report.txt"), join(a.workspaceRoot, "report.txt"));
		await a.engine.runOnce();
		await b.engine.runOnce();

		const names = readdirSync(b.workspaceRoot);
		expect(names).toContain("report.txt");
		expect(names).not.toContain("Report.txt");
		expect(b.engine.status().conflicts).toHaveLength(0);
	});

	it("keeps a newer manifest read-only instead of resetting or re-uploading", async () => {
		const port = new FakePort();
		port.manifests.set(
			"ws1__future.json",
			new TextEncoder().encode(
				JSON.stringify({
					version: 2,
					channel: "workspace-files",
					workspaceId: "ws1",
					batchId: "future",
					deviceId: "device-x",
					deviceName: "future",
					createdAt: "2026-01-01T00:00:00.000Z",
					operations: [],
				}),
			),
		);
		const b = device(port, "laptop", "device-b");
		await b.engine.runOnce();

		const status = b.engine.status();
		expect(status.issues.some((issue) => issue.reason === "unsupported-manifest")).toBe(true);
		expect(port.manifestWrites).toBe(0);
		expect(port.uploaded).toBe(0);
	});

	it("reports the first upload preflight, including secrets and excluded folders", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		writeFileSync(join(a.workspaceRoot, "doc.pdf"), "pdf");
		writeFileSync(join(a.workspaceRoot, ".env"), "SECRET=1");
		mkdirSync(join(a.workspaceRoot, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(a.workspaceRoot, "node_modules", "pkg", "index.js"), "x");

		const preflight = await a.engine.preflight("ws1");
		expect(preflight.ok).toBe(true);
		expect(preflight.files).toBe(2);
		expect(preflight.secrets).toContain(".env");
		expect(preflight.excluded?.some((label) => label.includes("node_modules"))).toBe(true);
	});

	it("publishes who owns a Drive folder and binds it on the other computer", async () => {
		const port = new FakePort();
		const driveRoot = mkdtempSync(join(tmpdir(), "myharness-drive-root-"));
		roots.push(driveRoot);
		mkdirSync(join(driveRoot, "Study", "OS"), { recursive: true });
		const a = device(port, "desktop", "device-a");
		const enabled = await a.engine.enableWorkspace("ws1", "drive", {
			driveRootId: "drive-a",
			driveRelativePath: "Study/OS",
		});
		expect(enabled.ok).toBe(true);
		expect(port.manifestWrites).toBe(1);

		const b = device(port, "laptop", "device-b");
		const placeholder = join(b.dataRoot, "workspace-folders", "os-test");
		mkdirSync(placeholder, { recursive: true });
		WorkspaceStore.create(b.agentDir, b.dataRoot).bindRoot("ws1", placeholder);
		const previous = process.env.MYHARNESS_DRIVE_ROOTS;
		process.env.MYHARNESS_DRIVE_ROOTS = driveRoot;
		try {
			await b.engine.runOnce();
		} finally {
			if (previous === undefined) delete process.env.MYHARNESS_DRIVE_ROOTS;
			else process.env.MYHARNESS_DRIVE_ROOTS = previous;
		}

		expect(WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws1")!.rootPath).toBe(
			join(driveRoot, "Study", "OS"),
		);
		const status = b.engine.status().workspaces.find((item) => item.workspaceId === "ws1");
		expect(status?.source).toBe("drive");
		expect(status?.managed).toBe(false);
		expect(status?.message).toContain("Google Drive 客户端");
	});

	it("never treats MyHarness's own data folder as a workspace to sync", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		const inside = join(a.dataRoot, "inside-data");
		mkdirSync(inside, { recursive: true });
		WorkspaceStore.create(a.agentDir, a.dataRoot).importWorkspace({
			workspaceId: "ws-inside",
			name: "Inside",
			rootPath: inside,
			modes: ["general"],
		});
		const result = await a.engine.enableWorkspace("ws-inside", "local", { confirmed: true });
		expect(result.ok).toBe(false);
		expect(port.manifestWrites).toBe(0);
	});

	it("refuses an excluded path coming from a remote manifest", async () => {
		const port = new FakePort();
		const body = new TextEncoder().encode("hostile");
		const hash = sha256(body);
		port.objects.set(hash, body);
		port.manifests.set(
			"ws1__excluded.json",
			new TextEncoder().encode(
				JSON.stringify({
					version: 1,
					channel: "workspace-files",
					workspaceId: "ws1",
					batchId: "excluded",
					deviceId: "device-x",
					deviceName: "other",
					createdAt: "2026-01-01T00:00:00.000Z",
					descriptor: {
						workspaceId: "ws1",
						name: "Study",
						source: "local",
						updatedAt: "2026-01-01T00:00:00.000Z",
						deviceName: "other",
					},
					operations: [{ path: ".git/config", type: "file", hash, size: body.byteLength, op: "put" }],
				}),
			),
		);
		const b = device(port, "laptop", "device-b");
		await b.engine.runOnce();

		expect(existsSync(join(b.workspaceRoot, ".git"))).toBe(false);
		expect(b.engine.status().issues.some((issue) => issue.detail.includes("excluded path"))).toBe(true);
	});
});

describe("Workspace file location and occupancy", () => {
	it("finds a Drive folder through the saved relative path and refuses an ambiguous root", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-location-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const dataRoot = join(root, "data");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(dataRoot, { recursive: true });
		const firstRoot = join(root, "drive-a");
		const secondRoot = join(root, "drive-b");
		mkdirSync(join(firstRoot, "Study", "OS"), { recursive: true });
		mkdirSync(join(secondRoot, "Study", "OS"), { recursive: true });
		const store = WorkspaceStore.create(agentDir, dataRoot);
		store.importWorkspace({
			workspaceId: "ws1",
			name: "OS",
			rootPath: join(dataRoot, "workspace-folders", "os-1"),
			modes: ["general"],
		});
		const descriptor = {
			workspaceId: "ws1",
			name: "OS",
			source: "drive" as const,
			driveRootId: "drive-a",
			driveRelativePath: "Study/OS",
			updatedAt: "2026-01-01T00:00:00.000Z",
			deviceName: "desktop",
		};
		const unique = locateDriveFolder(store, dataRoot, store.getById("ws1")!, descriptor, [
			{ path: firstRoot, id: "drive-a", label: "a" },
		]);
		expect(unique.ok).toBe(true);
		expect(unique.path).toBe(join(firstRoot, "Study", "OS"));
		expect(WorkspaceStore.create(agentDir, dataRoot).getById("ws1")!.rootPath).toBe(join(firstRoot, "Study", "OS"));

		const ambiguousStore = WorkspaceStore.create(agentDir, dataRoot);
		const placeholder = join(dataRoot, "workspace-folders", "os-2");
		ambiguousStore.importWorkspace({
			workspaceId: "ws2",
			name: "OS 2",
			rootPath: placeholder,
			modes: ["general"],
		});
		const ambiguous = locateDriveFolder(
			ambiguousStore,
			dataRoot,
			ambiguousStore.getById("ws2")!,
			{ ...descriptor, workspaceId: "ws2" },
			[
				{ path: firstRoot, id: "drive-a", label: "a" },
				{ path: secondRoot, id: "drive-b", label: "b" },
			],
		);
		expect(ambiguous.ok).toBe(false);
		expect(ambiguous.reason).toBe("ambiguous");
		expect(ambiguous.candidates).toHaveLength(2);
	});

	it("frees a path held by a hidden workspace while keeping its chats", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-occupancy-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const dataRoot = join(root, "data");
		const workspaceRoot = join(root, "Study", "OS");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(dataRoot, { recursive: true });
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(join(dataRoot, "workspaces", "ws-old", "sessions", "s1"), { recursive: true });
		const store = WorkspaceStore.create(agentDir, dataRoot);
		store.importWorkspace({
			workspaceId: "ws-old",
			name: "OS",
			rootPath: workspaceRoot,
			modes: ["general"],
		});
		expect(store.remove("ws-old", "general")).toBe(true);

		const occupancy = findWorkspaceOccupancy(store, dataRoot, workspaceRoot);
		expect(occupancy?.hidden).toBe(true);
		expect(occupancy?.chatCount).toBe(1);

		const released = releaseWorkspaceRoot(store, dataRoot, "ws-old");
		expect(released.ok).toBe(true);
		expect(released.path).toContain("reserved-");
		expect(WorkspaceStore.create(agentDir, dataRoot).getById("ws-old")!.rootPath).toBe(released.path);
		expect(existsSync(join(dataRoot, "workspaces", "ws-old", "sessions", "s1"))).toBe(true);

		const freed = WorkspaceStore.create(agentDir, dataRoot);
		const bound = freed.importWorkspace({
			workspaceId: "ws-new",
			name: "OS",
			rootPath: workspaceRoot,
			modes: ["general"],
		});
		expect(bound.ok).toBe(true);
	});

	it("finds Drive roots from the declared environment variable only when the folder exists", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-drive-roots-"));
		roots.push(root);
		const declared = join(root, "My Drive");
		mkdirSync(declared, { recursive: true });
		const rootsFound = discoverDriveRoots({ MYHARNESS_DRIVE_ROOTS: `${declared};${join(root, "missing")}` });
		expect(rootsFound.some((candidate) => candidate.path === declared)).toBe(true);
		expect(rootsFound.some((candidate) => candidate.path === join(root, "missing"))).toBe(false);
	});

	it("never overwrites a state file written by a newer version", async () => {
		const port = new FakePort();
		port.manifests.set(
			"ws1__future.json",
			new TextEncoder().encode(
				JSON.stringify({
					version: 2,
					channel: "workspace-files",
					workspaceId: "ws1",
					batchId: "future",
					deviceId: "device-x",
					deviceName: "future",
					createdAt: "2026-01-01T00:00:00.000Z",
					operations: [],
				}),
			),
		);
		const b = device(port, "laptop", "device-b");
		const path = new WorkspaceFileStateStore(b.agentDir, "account-1").pathFor("ws1");
		mkdirSync(dirname(path), { recursive: true });
		const original = JSON.stringify({
			version: 2,
			workspaceId: "ws1",
			accountKey: "account-1",
			base: {},
			applied: [],
			marker: "keep-this-file",
		});
		writeFileSync(path, original);

		await b.engine.runOnce();

		expect(readFileSync(path, "utf8")).toBe(original);
		const status = b.engine.status().workspaces.find((item) => item.workspaceId === "ws1");
		expect(status?.message).toContain("只读");
		expect(status?.upToDate).toBe(false);
	});

	it("keeps retrying a manifest whose objects never arrived instead of dropping the files", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		writeFileSync(join(a.workspaceRoot, "missing.txt"), "payload");
		await enable(a);
		port.objects.clear();

		const b = device(port, "laptop", "device-b");
		for (let pass = 0; pass < 7; pass += 1) await b.engine.runOnce();

		expect(existsSync(join(b.workspaceRoot, "missing.txt"))).toBe(false);
		const loaded = new WorkspaceFileStateStore(b.agentDir, "account-1").load("ws1", "account-1");
		expect(loaded.state.applied.some((name) => name.startsWith("ws1__"))).toBe(false);
		expect(Object.keys(loaded.state.retryAfter ?? {}).length).toBeGreaterThan(0);
		expect(b.engine.status().workspaces.find((item) => item.workspaceId === "ws1")?.upToDate).toBe(false);
	});

	it("does not publish a delete for a file that could not be hashed", async () => {
		const port = new FakePort();
		let flaky = false;
		const scanner: typeof scanWorkspaceFiles = async (options) => {
			const result = await scanWorkspaceFiles(options);
			if (!flaky) return result;
			result.entries.delete("flaky.txt");
			result.unstable = ["flaky.txt"];
			return result;
		};
		const a = device(port, "desktop", "device-a", { scanner });
		writeFileSync(join(a.workspaceRoot, "flaky.txt"), "still here");
		await enable(a);
		const b = device(port, "laptop", "device-b");
		await b.engine.runOnce();
		expect(readFileSync(join(b.workspaceRoot, "flaky.txt"), "utf8")).toBe("still here");

		const writes = port.manifestWrites;
		flaky = true;
		await a.engine.runOnce();
		await b.engine.runOnce();

		expect(port.manifestWrites).toBe(writes);
		expect(existsSync(join(b.workspaceRoot, "flaky.txt"))).toBe(true);
		const loaded = new WorkspaceFileStateStore(b.agentDir, "account-1").load("ws1", "account-1");
		expect(loaded.state.base["flaky.txt"]?.hash).toBeDefined();
	});

	it("refuses a remote deletion inside a folder this device could not list", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		mkdirSync(join(a.workspaceRoot, "sub"), { recursive: true });
		writeFileSync(join(a.workspaceRoot, "sub", "a.txt"), "inside");
		await enable(a);

		let hide = false;
		const scanner: typeof scanWorkspaceFiles = async (options) => {
			const result = await scanWorkspaceFiles(options);
			if (!hide) return result;
			for (const key of [...result.entries.keys()]) {
				if (key === "sub" || key.startsWith("sub/")) result.entries.delete(key);
			}
			result.incomplete = ["sub"];
			return result;
		};
		const b = device(port, "laptop", "device-b", { scanner });
		await b.engine.runOnce();
		expect(readFileSync(join(b.workspaceRoot, "sub", "a.txt"), "utf8")).toBe("inside");

		rmSync(join(a.workspaceRoot, "sub"), { recursive: true, force: true });
		await a.engine.runOnce();
		hide = true;
		await b.engine.runOnce();

		expect(existsSync(join(b.workspaceRoot, "sub", "a.txt"))).toBe(true);
		expect(b.engine.status().workspaces.find((item) => item.workspaceId === "ws1")?.upToDate).toBe(false);
	});

	it("never follows a Drive relative path that climbs out of the sync root", async () => {
		const port = new FakePort();
		const stamp = new Date().toISOString();
		port.manifests.set(
			"ws1__escape.json",
			new TextEncoder().encode(
				JSON.stringify({
					version: 1,
					channel: "workspace-files",
					workspaceId: "ws1",
					batchId: "escape",
					deviceId: "device-a",
					deviceName: "desktop",
					createdAt: stamp,
					descriptor: {
						workspaceId: "ws1",
						name: "Study",
						source: "drive",
						driveRootId: "drive-1",
						driveRelativePath: "../../outside",
						deviceId: "device-a",
						updatedAt: stamp,
						deviceName: "desktop",
					},
					operations: [],
				}),
			),
		);
		const b = device(port, "laptop", "device-b");
		writeFileSync(join(b.workspaceRoot, "local.txt"), "local only");

		await b.engine.runOnce();

		const loaded = new WorkspaceFileStateStore(b.agentDir, "account-1").load("ws1", "account-1");
		expect(loaded.state.descriptor?.driveRelativePath).toBeUndefined();
		expect(port.manifestWrites).toBe(0);
		expect(port.uploaded).toBe(0);
	});

	it("creates its own copy on a new computer instead of reusing another one's path", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		writeFileSync(join(a.workspaceRoot, "note.txt"), "from desktop");
		await enable(a);

		const b = device(port, "laptop", "device-b");
		rmSync(b.workspaceRoot, { recursive: true, force: true });
		await b.engine.runOnce();
		await b.engine.runOnce();

		const bound = WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws1")!.rootPath;
		expect(bound).not.toBe(b.workspaceRoot);
		expect(bound.startsWith(join(b.root, "managed"))).toBe(true);
		expect(readFileSync(join(bound, "note.txt"), "utf8")).toBe("from desktop");
	});

	it("refuses to create its own copy inside a cloud folder", async () => {
		const port = new FakePort();
		const a = device(port, "desktop", "device-a");
		writeFileSync(join(a.workspaceRoot, "note.txt"), "from desktop");
		await enable(a);

		const b = device(port, "laptop", "device-b");
		rmSync(b.workspaceRoot, { recursive: true, force: true });
		const cloud = join(b.root, "OneDrive");
		mkdirSync(join(cloud, "Workspaces"), { recursive: true });
		process.env.OneDrive = cloud;
		process.env.MYHARNESS_WORKSPACE_FILES_ROOT = join(cloud, "Workspaces");

		await b.engine.runOnce();

		expect(WorkspaceStore.create(b.agentDir, b.dataRoot).getById("ws1")!.rootPath).toBe(b.workspaceRoot);
		const status = b.engine.status().workspaces.find((item) => item.workspaceId === "ws1");
		expect(status?.upToDate).toBe(false);
		expect(status?.issues).toBeGreaterThan(0);
	});

	it("keeps a manifest pending when it contains a refused path", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-apply-refused-"));
		roots.push(root);
		const good = new TextEncoder().encode("good");
		const state: WorkspaceFileState = {
			version: 1,
			workspaceId: "ws1",
			accountKey: "account-1",
			base: {},
			applied: [],
			incomplete: [],
			rootMissing: false,
			conflicts: [],
			issues: [],
			transfers: {},
		};
		const manifest: WorkspaceFileManifest = {
			version: 1,
			channel: "workspace-files",
			workspaceId: "ws1",
			batchId: "b",
			deviceId: "device-a",
			deviceName: "desktop",
			createdAt: new Date().toISOString(),
			operations: [
				{ op: "put", type: "file", path: "good.txt", hash: sha256(good), size: good.byteLength },
				{ op: "put", type: "file", path: "../escape.txt", hash: sha256(good), size: good.byteLength },
			],
		};

		const result = await applyWorkspaceFileManifest(
			{
				root,
				state,
				deviceName: "desktop",
				backup: () => "backup",
				download: async (_hash, tempPath) => {
					writeFileSync(tempPath, good);
				},
			},
			manifest,
			new Map(),
			new Map(),
			"desktop",
		);

		// The valid file is applied, but the refused one must keep the whole manifest pending.
		expect(result.applied).toBe(1);
		expect(result.failed).toBe(1);
		expect(existsSync(join(root, "escape.txt"))).toBe(false);
	});

	it("refuses to replace a file when no recoverable copy can be written", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-apply-backup-"));
		roots.push(root);
		writeFileSync(join(root, "doc.txt"), "original");
		const body = new TextEncoder().encode("new");
		const state: WorkspaceFileState = {
			version: 1,
			workspaceId: "ws1",
			accountKey: "account-1",
			base: {
				"doc.txt": {
					path: "doc.txt",
					type: "file",
					hash: sha256(new TextEncoder().encode("original")),
					size: 8,
				},
			},
			applied: [],
			incomplete: [],
			rootMissing: false,
			conflicts: [],
			issues: [],
			transfers: {},
		};
		const manifest: WorkspaceFileManifest = {
			version: 1,
			channel: "workspace-files",
			workspaceId: "ws1",
			batchId: "b",
			deviceId: "device-a",
			deviceName: "desktop",
			createdAt: new Date().toISOString(),
			operations: [{ op: "put", type: "file", path: "doc.txt", hash: sha256(body), size: body.byteLength }],
		};

		const result = await applyWorkspaceFileManifest(
			{
				root,
				state,
				deviceName: "desktop",
				backup: () => {
					throw new Error("no space for a copy");
				},
				download: async (_hash, tempPath) => {
					writeFileSync(tempPath, body);
				},
			},
			manifest,
			new Map([
				[
					"doc.txt",
					{
						path: "doc.txt",
						type: "file" as const,
						hash: sha256(new TextEncoder().encode("original")),
						size: 8,
					},
				],
			]),
			new Map(),
			"desktop",
		);

		expect(result.failed).toBe(1);
		expect(readFileSync(join(root, "doc.txt"), "utf8")).toBe("original");
	});

	it("never writes through a link inside the workspace", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-apply-link-"));
		const outside = mkdtempSync(join(tmpdir(), "myharness-apply-outside-"));
		roots.push(root, outside);
		symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
		const body = new TextEncoder().encode("evil");
		const state: WorkspaceFileState = {
			version: 1,
			workspaceId: "ws1",
			accountKey: "account-1",
			base: {},
			applied: [],
			incomplete: [],
			rootMissing: false,
			conflicts: [],
			issues: [],
			transfers: {},
		};
		const manifest: WorkspaceFileManifest = {
			version: 1,
			channel: "workspace-files",
			workspaceId: "ws1",
			batchId: "b",
			deviceId: "device-a",
			deviceName: "desktop",
			createdAt: new Date().toISOString(),
			operations: [{ op: "put", type: "file", path: "link/evil.txt", hash: sha256(body), size: body.byteLength }],
		};

		const result = await applyWorkspaceFileManifest(
			{
				root,
				state,
				deviceName: "desktop",
				backup: () => "backup",
				download: async (_hash, tempPath) => {
					writeFileSync(tempPath, body);
				},
			},
			manifest,
			new Map(),
			new Map(),
			"desktop",
		);

		expect(existsSync(join(outside, "evil.txt"))).toBe(false);
		expect(result.failed).toBe(1);
	});
});
