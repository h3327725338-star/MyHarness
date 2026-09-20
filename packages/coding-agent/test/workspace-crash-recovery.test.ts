import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceMetadataPath, getWorkspaceRegistryPath } from "../src/config/paths/index.ts";
import { WorkspaceStore } from "../src/data/workspace-store.ts";
import { cleanupStaleAtomicWriteTemps } from "../src/utils/atomic-write.ts";

type CrashTarget = "registry" | "metadata";

interface Fixture {
	root: string;
	dataRoot: string;
	agentDir: string;
	projectRoot: string;
	newProjectRoot: string;
	workspaceRoots: string[];
	targetWorkspaceId: string;
}

const cleanupRoots: string[] = [];

afterEach(() => {
	for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function findAtomicTemps(root: string): string[] {
	const result: string[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".tmp")) result.push(path);
		}
	};
	visit(root);
	return result;
}

async function waitForChildClose(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null) return child.exitCode;
	return await new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

function createDriver(root: string): { driverPath: string; hookPath: string } {
	const driverPath = join(root, "workspace-crash-driver.mjs");
	const hookPath = join(root, "workspace-crash-hook.mjs");
	const moduleUrl = new URL("../src/data/workspace-store.ts", import.meta.url).href;
	writeFileSync(
		driverPath,
		[
			`import { WorkspaceStore } from ${JSON.stringify(moduleUrl)};`,
			"const [operation, agentDir, dataRoot, firstRoot, secondRoot, targetId] = process.argv.slice(2);",
			"const store = WorkspaceStore.create(agentDir, dataRoot);",
			"if (operation === 'create') store.add(secondRoot);",
			"else if (operation === 'rename') store.relocateUnderRoot(firstRoot, secondRoot);",
			"else if (operation === 'remove') store.remove(targetId);",
			"else if (operation === 'persist') store.persist();",
			"else throw new Error('unknown operation: ' + operation);",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		hookPath,
		[
			'import fs from "node:fs";',
			'import { syncBuiltinESMExports } from "node:module";',
			"const target = process.env.MYHARNESS_CRASH_TARGET;",
			"const originalRenameSync = fs.renameSync;",
			"fs.renameSync = (oldPath, newPath) => {",
			"  const result = originalRenameSync(oldPath, newPath);",
			"  const normalized = String(newPath).replaceAll('\\\\', '/');",
			"  const isRegistry = target === 'registry' && normalized.endsWith('/registry.json');",
			"  const isMetadata = target === 'metadata' && normalized.includes('/metadata/') && normalized.endsWith('/metadata.json');",
			"  if (isRegistry || isMetadata) process.kill(process.pid, 'SIGKILL');",
			"  return result;",
			"};",
			"syncBuiltinESMExports();",
			"",
		].join("\n"),
		"utf8",
	);
	return { driverPath, hookPath };
}

function createFixture(operation: "create" | "rename" | "remove"): Fixture {
	const root = mkdtempSync(join(tmpdir(), "myharness-workspace-crash-matrix-"));
	cleanupRoots.push(root);
	const dataRoot = join(root, "data");
	const agentDir = join(root, "agent");
	const projectRoot = join(root, "project");
	const newProjectRoot = join(root, "project-renamed");
	mkdirSync(dataRoot, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectRoot, { recursive: true });
	const workspaceRoots: string[] = [];
	const count = 300;
	const store = WorkspaceStore.create(agentDir, dataRoot);
	for (let index = 0; index < count; index += 1) {
		const workspaceRoot =
			operation === "rename" ? join(projectRoot, `workspace-${index}`) : join(root, `workspace-${index}`);
		mkdirSync(workspaceRoot, { recursive: true });
		workspaceRoots.push(workspaceRoot);
		const result = store.add(workspaceRoot, process.cwd(), false);
		if (!result.ok) throw new Error(result.error ?? `failed to seed workspace ${index}`);
	}
	store.persist();
	const targetWorkspaceId = store.list()[Math.floor(count / 2)]!.workspaceId;
	if (operation === "rename") renameSync(projectRoot, newProjectRoot);
	const secondRoot = operation === "create" ? join(root, "created-workspace") : newProjectRoot;
	if (operation === "create") mkdirSync(secondRoot, { recursive: true });
	return { root, dataRoot, agentDir, projectRoot, newProjectRoot, workspaceRoots, targetWorkspaceId };
}

function readRegistry(dataRoot: string): Array<{ workspaceId: string; rootPath: string }> {
	const value = JSON.parse(readFileSync(getWorkspaceRegistryPath(dataRoot), "utf8")) as {
		workspaces?: Array<{ workspaceId?: unknown; rootPath?: unknown }>;
	};
	return (value.workspaces ?? []).filter(
		(workspace): workspace is { workspaceId: string; rootPath: string } =>
			typeof workspace.workspaceId === "string" && typeof workspace.rootPath === "string",
	);
}

function assertRegistryMetadataConsistency(dataRoot: string): void {
	const registry = readRegistry(dataRoot);
	const registryIds = new Set(registry.map((workspace) => workspace.workspaceId));
	for (const workspace of registry) {
		const metadataPath = getWorkspaceMetadataPath(dataRoot, workspace.workspaceId);
		expect(existsSync(metadataPath)).toBe(true);
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
			workspace?: { workspaceId?: unknown; rootPath?: unknown };
		};
		expect(metadata.workspace?.workspaceId).toBe(workspace.workspaceId);
		expect(metadata.workspace?.rootPath).toBe(workspace.rootPath);
	}
	expect(findAtomicTemps(dataRoot)).toHaveLength(0);
	// Only metadata belonging to the registry is active. Removed Workspace data
	// is intentionally retained for Session recovery and is not re-listed while
	// the authoritative registry is readable.
	const activeMetadata = readdirSync(join(dataRoot, "workspaces"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((id) => registryIds.has(id));
	expect(new Set(activeMetadata)).toEqual(registryIds);
}

async function crashDuringSave(fixture: Fixture, operation: string, target: CrashTarget): Promise<void> {
	const { driverPath, hookPath } = createDriver(fixture.root);
	const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
	const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
	const child = spawn(
		process.execPath,
		[
			"--import",
			hookPath,
			tsxCli,
			driverPath,
			operation,
			fixture.agentDir,
			fixture.dataRoot,
			fixture.projectRoot,
			fixture.newProjectRoot,
			fixture.targetWorkspaceId,
		],
		{
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
			env: { ...process.env, MYHARNESS_CRASH_TARGET: target },
		},
	);
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk) => {
		output += chunk.toString();
	});
	const exitCode = await waitForChildClose(child);
	if (exitCode === 0)
		throw new Error(`crash hook did not interrupt ${target} atomic write for ${operation}; child output: ${output}`);

	// Startup cleanup is part of the real migration path. It removes only dead
	// owner temp files, after which the registry/metadata recovery is inspected.
	cleanupStaleAtomicWriteTemps(fixture.dataRoot, { minAgeMs: 0 });
	assertRegistryMetadataConsistency(fixture.dataRoot);
}

describe("WorkspaceStore crash recovery matrix", () => {
	it("recovers create, rename, metadata, registry/delete interruption and idempotent reconcile", async () => {
		const create = createFixture("create");
		await crashDuringSave(create, "create", "registry");
		const created = WorkspaceStore.create(create.agentDir, create.dataRoot);
		expect(created.list().length).toBeGreaterThanOrEqual(create.workspaceRoots.length);
		created.ensureForPath(join(create.root, "created-workspace"));
		const afterCreate = WorkspaceStore.create(create.agentDir, create.dataRoot);
		expect(afterCreate.list()).toHaveLength(create.workspaceRoots.length + 1);
		expect(afterCreate.getByRootPath(join(create.root, "created-workspace"))).toBeDefined();
		assertRegistryMetadataConsistency(create.dataRoot);

		const rename = createFixture("rename");
		await crashDuringSave(rename, "rename", "registry");
		let afterRename = WorkspaceStore.create(rename.agentDir, rename.dataRoot);
		if (afterRename.getByRootPath(rename.newProjectRoot) === undefined) {
			afterRename.relocateUnderRoot(rename.projectRoot, rename.newProjectRoot);
		}
		afterRename.persist();
		afterRename = WorkspaceStore.create(rename.agentDir, rename.dataRoot);
		const oldPrefix = `${rename.projectRoot}${process.platform === "win32" ? "\\" : "/"}`;
		expect(
			afterRename
				.list()
				.every(
					(workspace) => workspace.rootPath !== rename.projectRoot && !workspace.rootPath.startsWith(oldPrefix),
				),
		).toBe(true);
		expect(afterRename.list()).toHaveLength(rename.workspaceRoots.length);
		expect(
			afterRename.list().every((workspace) => workspace.rootPath.startsWith(`${rename.newProjectRoot}${sep}`)),
		).toBe(true);
		assertRegistryMetadataConsistency(rename.dataRoot);

		const metadata = createFixture("rename");
		await crashDuringSave(metadata, "rename", "metadata");
		const reconciled = WorkspaceStore.create(metadata.agentDir, metadata.dataRoot);
		reconciled.persist();
		expect(reconciled.list()).toHaveLength(metadata.workspaceRoots.length);
		assertRegistryMetadataConsistency(metadata.dataRoot);
		const firstSnapshot = readFileSync(getWorkspaceRegistryPath(metadata.dataRoot), "utf8");
		const secondReconcile = WorkspaceStore.create(metadata.agentDir, metadata.dataRoot);
		secondReconcile.persist();
		expect(readFileSync(getWorkspaceRegistryPath(metadata.dataRoot), "utf8")).toBe(firstSnapshot);
		expect(secondReconcile.getConsistencyIssues().filter((issue) => issue.status === "repaired")).toHaveLength(0);

		const remove = createFixture("remove");
		await crashDuringSave(remove, "remove", "registry");
		const afterRemove = WorkspaceStore.create(remove.agentDir, remove.dataRoot);
		afterRemove.remove(remove.targetWorkspaceId);
		const afterDelete = WorkspaceStore.create(remove.agentDir, remove.dataRoot);
		expect(afterDelete.list()).toHaveLength(remove.workspaceRoots.length - 1);
		expect(afterDelete.getById(remove.targetWorkspaceId)).toBeUndefined();
		assertRegistryMetadataConsistency(remove.dataRoot);

		const reconcileRoot = mkdtempSync(join(tmpdir(), "myharness-workspace-reconcile-"));
		cleanupRoots.push(reconcileRoot);
		const reconcileData = join(reconcileRoot, "data");
		const reconcileAgent = join(reconcileRoot, "agent");
		const reconcileProject = join(reconcileRoot, "project");
		mkdirSync(reconcileProject, { recursive: true });
		const seeded = WorkspaceStore.create(reconcileAgent, reconcileData).add(reconcileProject);
		expect(seeded.ok).toBe(true);
		const repairedMetadata = getWorkspaceMetadataPath(reconcileData, seeded.workspace!.workspaceId);
		writeFileSync(repairedMetadata, "{broken", "utf8");
		const first = WorkspaceStore.create(reconcileAgent, reconcileData);
		expect(first.getConsistencyIssues()).toEqual(
			expect.arrayContaining([expect.objectContaining({ status: "repaired" })]),
		);
		const second = WorkspaceStore.create(reconcileAgent, reconcileData);
		expect(second.getConsistencyIssues()).toHaveLength(0);
		assertRegistryMetadataConsistency(reconcileData);
	}, 120_000);
});
