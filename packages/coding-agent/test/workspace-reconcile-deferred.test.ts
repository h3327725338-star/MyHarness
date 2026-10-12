/**
 * W197: Workspace metadata reconciliation is deferred off WorkspaceStore.create().
 *
 * Locks three contracts:
 * 1. create() no longer reconciles synchronously; the scheduled pass repairs the
 *    same drift and reports the same issues once it completes.
 * 2. For every drift shape (missing/corrupt/mismatched metadata, missing root,
 *    orphan directory, case-different paths) the final on-disk state and the
 *    resulting issue triples are identical to the previous synchronous
 *    implementation (kept as a reference implementation in this file).
 * 3. The asynchronous pass is cancellable, coalesced, never throws, and never
 *    keeps a short-lived process alive (unref()ed timers).
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceMetadataPath, getWorkspaceRegistryPath, getWorkspacesDir } from "../src/config/paths/index.ts";
import {
	cancelWorkspaceMetadataReconciles,
	flushWorkspaceMetadataReconciles,
	hasPendingWorkspaceMetadataReconcile,
} from "../src/data/workspace-reconcile.ts";
import type { Workspace, WorkspaceConsistencyIssue } from "../src/data/workspace-store.ts";
import { WorkspaceStore } from "../src/data/workspace-store.ts";
import { writeFileAtomicallySync } from "../src/utils/atomic-write.ts";
import { pathIdentityKey, resolvePath } from "../src/utils/paths.ts";

const SAFE_WORKSPACE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function createScratch(prefix: string): { dir: string; cleanup: () => void } {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return {
		dir,
		cleanup: () => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		},
	};
}

function metadataFile(workspace: Workspace): string {
	return `${JSON.stringify({ version: 1, workspace: { workspaceId: workspace.workspaceId, modes: workspace.modes ?? ["coding"], name: workspace.name, rootPath: workspace.rootPath, createdAt: workspace.createdAt } }, null, 2)}\n`;
}

interface FixtureWorkspace extends Workspace {
	variant: string;
}

/**
 * Builds <base>/agent + <base>/data with one workspace per drift variant.
 * The same builder runs against two independent bases so the old (reference)
 * and new (deferred) implementations start from byte-identical trees.
 */
function buildFixture(baseDir: string): { agentDir: string; dataRoot: string; workspaces: FixtureWorkspace[] } {
	const agentDir = join(baseDir, "agent");
	const dataRoot = join(baseDir, "data");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(dataRoot, "workspaces"), { recursive: true });
	const projectsDir = join(dataRoot, "projects");
	mkdirSync(projectsDir, { recursive: true });

	const spec: Array<{ id: string; variant: string; rootName: string }> = [
		{ id: "ws-healthy", variant: "healthy", rootName: "healthy-project" },
		{ id: "ws-missing-meta", variant: "missing_metadata", rootName: "missing-meta-project" },
		{ id: "ws-corrupt", variant: "corrupt_metadata", rootName: "corrupt-project" },
		{ id: "ws-mismatch", variant: "metadata_mismatch", rootName: "mismatch-project" },
		{ id: "ws-missing-root", variant: "missing_root", rootName: "gone-project" },
		{ id: "ws-casing", variant: "casing", rootName: "cased-project" },
	];

	const workspaces: FixtureWorkspace[] = [];
	for (const entry of spec) {
		const actualRoot = join(projectsDir, entry.rootName);
		if (entry.variant !== "missing_root") mkdirSync(actualRoot, { recursive: true });
		// The registry uses a case-different spelling for the casing fixture only.
		const registryRoot = entry.variant === "casing" ? join(projectsDir, entry.rootName.toUpperCase()) : actualRoot;
		const workspace: FixtureWorkspace = {
			variant: entry.variant,
			workspaceId: entry.id,
			id: entry.id,
			name: entry.id,
			rootPath: registryRoot,
			createdAt: "2026-09-18T00:00:00.000Z",
			modes: ["coding"],
		};
		workspaces.push(workspace);
		const metadataPath = getWorkspaceMetadataPath(dataRoot, entry.id);
		if (entry.variant === "missing_metadata") continue;
		if (entry.variant === "corrupt_metadata") {
			mkdirSync(join(dataRoot, "workspaces", entry.id, "metadata"), { recursive: true });
			writeFileSync(metadataPath, "{broken", "utf8");
			continue;
		}
		if (entry.variant === "metadata_mismatch") {
			mkdirSync(join(dataRoot, "workspaces", entry.id, "metadata"), { recursive: true });
			writeFileSync(
				metadataPath,
				`${JSON.stringify({ version: 1, workspace: { workspaceId: entry.id, modes: ["coding"], name: "old-name", rootPath: workspace.rootPath, createdAt: workspace.createdAt } }, null, 2)}\n`,
				"utf8",
			);
			continue;
		}
		// healthy / missing_root / casing: metadata matches the registry exactly.
		mkdirSync(join(dataRoot, "workspaces", entry.id, "metadata"), { recursive: true });
		writeFileAtomicallySync(metadataPath, metadataFile(workspace));
	}

	// Orphan workspace directory: present on disk, absent from the registry.
	const orphanId = "ws-orphan";
	mkdirSync(join(dataRoot, "workspaces", orphanId, "metadata"), { recursive: true });
	writeFileAtomicallySync(
		getWorkspaceMetadataPath(dataRoot, orphanId),
		metadataFile({
			workspaceId: orphanId,
			id: orphanId,
			name: "ws-orphan",
			rootPath: join(projectsDir, "orphan-project"),
			createdAt: "2026-09-18T00:00:00.000Z",
		}),
	);

	writeFileAtomicallySync(
		getWorkspaceRegistryPath(dataRoot),
		`${JSON.stringify({ version: 2, workspaces: workspaces.map((w) => ({ workspaceId: w.workspaceId, modes: w.modes, name: w.name, rootPath: w.rootPath, createdAt: w.createdAt })) }, null, 2)}\n`,
	);
	return { agentDir, dataRoot, workspaces };
}

/**
 * Reference implementation: the pre-W197 synchronous
 * WorkspaceStore.reconcileMetadata(), kept verbatim for the comparison test.
 */
function referenceReconcile(dataRoot: string, workspaces: Workspace[]): WorkspaceConsistencyIssue[] {
	const issues: WorkspaceConsistencyIssue[] = [];
	const pathsEqual = (a: string, b: string) => pathIdentityKey(a) === pathIdentityKey(b);
	const readWorkspaceMetadata = (path: string): Workspace | undefined => {
		try {
			if (!existsSync(path)) return undefined;
			const stats = lstatSync(path);
			if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
			const value = (JSON.parse(readFileSync(path, "utf8")) as { workspace?: unknown }).workspace;
			if (typeof value !== "object" || value === null) return undefined;
			const candidate = value as Record<string, unknown>;
			if (
				typeof candidate.name !== "string" ||
				typeof candidate.rootPath !== "string" ||
				candidate.rootPath.length === 0 ||
				typeof candidate.createdAt !== "string"
			) {
				return undefined;
			}
			const rootPath = resolvePath(candidate.rootPath);
			const persistedId =
				typeof candidate.workspaceId === "string" && SAFE_WORKSPACE_ID.test(candidate.workspaceId)
					? candidate.workspaceId
					: undefined;
			return {
				workspaceId: persistedId ?? rootPath,
				id: persistedId ?? rootPath,
				name: candidate.name || rootPath,
				rootPath,
				createdAt: candidate.createdAt,
			};
		} catch {
			return undefined;
		}
	};
	for (const workspace of workspaces) {
		const metadataPath = getWorkspaceMetadataPath(dataRoot, workspace.workspaceId);
		let metadata: Workspace | undefined;
		let metadataExists = false;
		try {
			metadataExists = existsSync(metadataPath);
			metadata = readWorkspaceMetadata(metadataPath);
		} catch {
			metadata = undefined;
		}

		if (!existsSync(workspace.rootPath)) {
			issues.push({
				workspaceId: workspace.workspaceId,
				code: "missing_root",
				path: workspace.rootPath,
				status: "unresolved",
				message: `Workspace root does not exist: ${workspace.rootPath}`,
			});
		}

		const mismatch =
			metadata === undefined ||
			metadata.workspaceId !== workspace.workspaceId ||
			metadata.name !== workspace.name ||
			!pathsEqual(metadata.rootPath, workspace.rootPath) ||
			metadata.createdAt !== workspace.createdAt;
		if (!mismatch) continue;

		const code: WorkspaceConsistencyIssue["code"] = !metadataExists
			? "missing_metadata"
			: metadata === undefined
				? "invalid_metadata"
				: "metadata_mismatch";
		try {
			// Mirror the production writeJsonAtomically(): mkdir of the metadata parent.
			mkdirSync(join(dataRoot, "workspaces", workspace.workspaceId, "metadata"), { recursive: true });
			writeFileAtomicallySync(metadataPath, metadataFile(workspace));
			issues.push({
				workspaceId: workspace.workspaceId,
				code,
				path: metadataPath,
				status: "repaired",
				message: `Workspace metadata was repaired from the authoritative registry: ${metadataPath}`,
			});
		} catch (error) {
			issues.push({
				workspaceId: workspace.workspaceId,
				code: "metadata_repair_failed",
				path: metadataPath,
				status: "unresolved",
				message: `Workspace metadata could not be repaired: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	return issues;
}

/** Final on-disk state of a fixture, with the fixture base normalized away. */
function snapshotState(dataRoot: string, baseDir: string): string {
	// Paths appear both raw and JSON-escaped ("\\") inside the file contents.
	const escaped = baseDir.replace(/\\/gu, "\\\\");
	const normalize = (text: string) => text.replaceAll(escaped, "<BASE>").replaceAll(baseDir, "<BASE>");
	const lines: string[] = [];
	lines.push(`registry=${normalize(readFileSync(getWorkspaceRegistryPath(dataRoot), "utf8"))}`);
	const entries = readdirSync(getWorkspacesDir(dataRoot), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	for (const id of entries) {
		const metadataPath = getWorkspaceMetadataPath(dataRoot, id);
		const content = existsSync(metadataPath) ? normalize(readFileSync(metadataPath, "utf8")) : "<MISSING>";
		lines.push(`metadata:${id}=${content}`);
	}
	return lines.join("\n");
}

function issueTriples(issues: readonly WorkspaceConsistencyIssue[]): string[] {
	return issues.map((issue) => `${issue.workspaceId}|${issue.code}|${issue.status}`).sort();
}

afterEach(() => {
	cancelWorkspaceMetadataReconciles();
});

describe("W197 deferred workspace metadata reconcile", () => {
	it("create() does not reconcile synchronously; the scheduled pass repairs and reports", () => {
		const scratch = createScratch("myharness-w197-deferred");
		try {
			const fixture = buildFixture(scratch.dir);
			const store = WorkspaceStore.create(fixture.agentDir, fixture.dataRoot);
			// Nothing on the startup list changed (registry is authoritative either way).
			expect(store.list()).toHaveLength(fixture.workspaces.length);
			// But the repair must NOT have happened synchronously: the missing
			// metadata file is still absent and no issues were recorded yet.
			expect(existsSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-missing-meta"))).toBe(false);
			expect(store.getConsistencyIssues()).toHaveLength(0);
			expect(hasPendingWorkspaceMetadataReconcile(resolvePath(fixture.dataRoot))).toBe(true);

			flushWorkspaceMetadataReconciles();

			expect(existsSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-missing-meta"))).toBe(true);
			expect(
				JSON.parse(readFileSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-missing-meta"), "utf8")).workspace
					.name,
			).toBe("ws-missing-meta");
			expect(readFileSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-corrupt"), "utf8")).not.toBe("{broken");
			const codes = store.getConsistencyIssues().map((issue) => issue.code);
			expect(codes).toContain("missing_metadata");
			expect(codes).toContain("invalid_metadata");
			expect(codes).toContain("metadata_mismatch");
			expect(hasPendingWorkspaceMetadataReconcile(resolvePath(fixture.dataRoot))).toBe(false);
		} finally {
			scratch.cleanup();
		}
	});

	it("safety matrix: deferred pass reaches the identical final state as the old synchronous reconcile", () => {
		const scratchOld = createScratch("myharness-w197-old");
		const scratchNew = createScratch("myharness-w197-new");
		try {
			const oldFixture = buildFixture(scratchOld.dir);
			const newFixture = buildFixture(scratchNew.dir);

			// Old behavior: synchronous reconcile right after create (reference copy).
			const oldStore = WorkspaceStore.create(oldFixture.agentDir, oldFixture.dataRoot);
			const oldIssues = referenceReconcile(oldFixture.dataRoot, oldStore.list());

			// New behavior: deferred pass scheduled by create, then completed.
			const newStore = WorkspaceStore.create(newFixture.agentDir, newFixture.dataRoot);
			flushWorkspaceMetadataReconciles();
			const newIssues = newStore.getConsistencyIssues();

			// Per-variant report: every drift shape lands on one line each.
			const perVariant: string[] = [];
			for (const workspace of oldFixture.workspaces) {
				const oldIssue = oldIssues.find((issue) => issue.workspaceId === workspace.workspaceId);
				const newIssue = newIssues.find((issue) => issue.workspaceId === workspace.workspaceId);
				perVariant.push(
					`${workspace.variant}: old=${oldIssue?.code ?? "none"}/${oldIssue?.status ?? "-"} new=${newIssue?.code ?? "none"}/${newIssue?.status ?? "-"}`,
				);
			}
			perVariant.push(
				`orphan_dir: old=${oldIssues.some((i) => i.workspaceId === "ws-orphan") ? "touched" : "untouched"} new=${newIssues.some((i) => i.workspaceId === "ws-orphan") ? "touched" : "untouched"}`,
			);
			process.stdout.write(`${perVariant.join("\n")}\n`);

			// Workspace lists identical (modulo fixture base path).
			const normList = (workspaces: Workspace[], baseDir: string) =>
				workspaces.map((workspace) => ({
					...workspace,
					rootPath: workspace.rootPath
						.replace(/\\/gu, "/")
						.toLowerCase()
						.replaceAll(`${baseDir.replace(/\\/gu, "/").toLowerCase()}`, "<BASE>"),
				}));
			expect(normList(newStore.list(), scratchNew.dir)).toEqual(normList(oldStore.list(), scratchOld.dir));

			// Final on-disk state identical item-by-item.
			expect(snapshotState(newFixture.dataRoot, scratchNew.dir)).toBe(
				snapshotState(oldFixture.dataRoot, scratchOld.dir),
			);

			// Issue triples identical, one per anomaly class as applicable.
			expect(issueTriples(newIssues)).toEqual(issueTriples(oldIssues));
		} finally {
			scratchOld.cleanup();
			scratchNew.cleanup();
		}
	});

	it("casing drift: both implementations agree on whether the metadata matches", () => {
		const scratch = createScratch("myharness-w197-casing");
		try {
			const fixture = buildFixture(scratch.dir);
			const store = WorkspaceStore.create(fixture.agentDir, fixture.dataRoot);
			store.reconcileMetadataNow();
			const casingIssue = store.getConsistencyIssues().find((issue) => issue.workspaceId === "ws-casing");
			// On case-insensitive filesystems there is no drift at all; on
			// case-sensitive ones the root is simply missing. Either way no repair
			// churn: metadata content must stay untouched.
			const metadataPath = getWorkspaceMetadataPath(fixture.dataRoot, "ws-casing");
			const registryWorkspace = fixture.workspaces.find((w) => w.workspaceId === "ws-casing")!;
			expect(readFileSync(metadataPath, "utf8")).toBe(metadataFile(registryWorkspace));
			expect(["none", "missing_root"]).toContain(casingIssue?.code ?? "none");
		} finally {
			scratch.cleanup();
		}
	});

	it("repeated creates coalesce into one pass; every store receives the result", () => {
		const scratch = createScratch("myharness-w197-coalesce");
		try {
			const fixture = buildFixture(scratch.dir);
			const first = WorkspaceStore.create(fixture.agentDir, fixture.dataRoot);
			const second = WorkspaceStore.create(fixture.agentDir, fixture.dataRoot);
			expect(first.getConsistencyIssues()).toHaveLength(0);
			expect(second.getConsistencyIssues()).toHaveLength(0);
			flushWorkspaceMetadataReconciles();
			// Both stores were attached to the single scheduled pass.
			expect(first.getConsistencyIssues().map((i) => i.code)).toContain("missing_metadata");
			expect(second.getConsistencyIssues().map((i) => i.code)).toContain("missing_metadata");
			expect(existsSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-missing-meta"))).toBe(true);
		} finally {
			scratch.cleanup();
		}
	});

	it("a registry save cancels the in-flight pass and leaves everything consistent", () => {
		const scratch = createScratch("myharness-w197-save-cancel");
		try {
			const fixture = buildFixture(scratch.dir);
			const store = WorkspaceStore.create(fixture.agentDir, fixture.dataRoot);
			expect(hasPendingWorkspaceMetadataReconcile(resolvePath(fixture.dataRoot))).toBe(true);
			const projectDir = join(scratch.dir, "projects", "added-project");
			mkdirSync(projectDir, { recursive: true });
			expect(store.add(join(scratch.dir, "projects", "added-project")).ok).toBe(true);
			// save() wrote registry + every metadata file; the stale pass is gone.
			expect(hasPendingWorkspaceMetadataReconcile(resolvePath(fixture.dataRoot))).toBe(false);
			for (const workspace of store.list()) {
				expect(existsSync(getWorkspaceMetadataPath(fixture.dataRoot, workspace.workspaceId))).toBe(true);
			}
		} finally {
			scratch.cleanup();
		}
	});

	it("cancelWorkspaceMetadataReconciles() stops the pass; the next create re-schedules", () => {
		const scratch = createScratch("myharness-w197-cancel");
		try {
			const fixture = buildFixture(scratch.dir);
			const _store = WorkspaceStore.create(fixture.agentDir, fixture.dataRoot);
			cancelWorkspaceMetadataReconciles();
			expect(hasPendingWorkspaceMetadataReconcile(resolvePath(fixture.dataRoot))).toBe(false);
			// No repair happened.
			expect(existsSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-missing-meta"))).toBe(false);
			// A later create schedules a fresh pass that completes normally.
			const again = WorkspaceStore.create(fixture.agentDir, fixture.dataRoot);
			expect(hasPendingWorkspaceMetadataReconcile(resolvePath(fixture.dataRoot))).toBe(true);
			flushWorkspaceMetadataReconciles();
			expect(existsSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-missing-meta"))).toBe(true);
			expect(again.getConsistencyIssues().length).toBeGreaterThan(0);
		} finally {
			scratch.cleanup();
		}
	});

	it("a repair failure is reported unresolved and the pass never throws", () => {
		const scratch = createScratch("myharness-w197-fail");
		try {
			const fixture = buildFixture(scratch.dir);
			// Replace the metadata directory path with a regular file so the repair
			// write cannot succeed (ENOTDIR on mkdir of the parent path).
			rmSync(join(fixture.dataRoot, "workspaces", "ws-missing-meta"), { recursive: true, force: true });
			writeFileSync(join(fixture.dataRoot, "workspaces", "ws-missing-meta"), "not-a-directory", "utf8");
			const store = WorkspaceStore.create(fixture.agentDir, fixture.dataRoot);
			expect(() => flushWorkspaceMetadataReconciles()).not.toThrow();
			const failure = store.getConsistencyIssues().find((issue) => issue.workspaceId === "ws-missing-meta");
			expect(failure?.code).toBe("metadata_repair_failed");
			// Other workspaces were still repaired.
			expect(existsSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-corrupt"))).toBe(true);
			expect(readFileSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-corrupt"), "utf8")).not.toBe("{broken");
		} finally {
			scratch.cleanup();
		}
	});

	it("the scheduled pass keeps an explicit synchronous escape hatch (reconcileMetadataNow)", () => {
		const scratch = createScratch("myharness-w197-now");
		try {
			const fixture = buildFixture(scratch.dir);
			const store = WorkspaceStore.create(fixture.agentDir, fixture.dataRoot);
			store.reconcileMetadataNow();
			expect(store.getConsistencyIssues().map((i) => i.code)).toContain("missing_metadata");
			expect(existsSync(getWorkspaceMetadataPath(fixture.dataRoot, "ws-missing-meta"))).toBe(true);
			// The scheduled pass still runs later and simply confirms consistency.
			flushWorkspaceMetadataReconciles();
			expect(store.list()).toHaveLength(fixture.workspaces.length);
		} finally {
			scratch.cleanup();
		}
	});

	it("unref()ed timers: a short-lived process exits without waiting for the pass", () => {
		const scratch = createScratch("myharness-w197-exit");
		// Repo root relative to this test file (packages/coding-agent/test/).
		const repoRoot = resolvePath(new URL("../../../", import.meta.url).pathname.replace(/^\//u, ""));
		const storeModuleUrl = pathToFileURL(
			join(repoRoot, "packages", "coding-agent", "src", "data", "workspace-store.ts"),
		).href;
		const loaderPath = join(repoRoot, "scripts", "dev-fast-loader.mjs");
		const childScript = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const base = ${JSON.stringify(scratch.dir)};
const agentDir = join(base, "agent");
const dataRoot = join(base, "data");
mkdirSync(join(dataRoot, "workspaces"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
const root = join(base, "project");
mkdirSync(root, { recursive: true });
const workspace = { workspaceId: "ws-a", name: "ws-a", rootPath: root, createdAt: "2026-09-18T00:00:00.000Z" };
writeFileSync(join(dataRoot, "workspaces", "registry.json"), JSON.stringify({ version: 2, workspaces: [workspace] }));
const { WorkspaceStore } = await import(${JSON.stringify(storeModuleUrl)});
const t0 = performance.now();
WorkspaceStore.create(agentDir, dataRoot);
process.on("beforeExit", () => {
	writeFileSync(join(base, "exit-result.json"), JSON.stringify({ elapsedMs: performance.now() - t0 }));
});
`;
		const childPath = join(scratch.dir, "child.mjs");
		writeFileSync(childPath, childScript, "utf8");
		try {
			// Windows absolute paths must be passed to --import as file:// URLs.
			const result = spawnSync(process.execPath, ["--import", pathToFileURL(loaderPath).href, childPath], {
				cwd: repoRoot,
				encoding: "utf8",
				timeout: 60_000,
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			const parsed = JSON.parse(readFileSync(join(scratch.dir, "exit-result.json"), "utf8")) as {
				elapsedMs: number;
			};
			// The scheduled pass starts at 750ms; an unref()ed timer must not keep
			// the loop alive, so beforeExit fires far earlier than that.
			expect(parsed.elapsedMs).toBeLessThan(500);
		} finally {
			scratch.cleanup();
		}
	});
});
