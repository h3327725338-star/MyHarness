import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspacesPath, validateWorkspacePath, WorkspaceStore } from "../src/application/workspace-store.ts";
import { getWorkspaceMetadataPath, getWorkspaceRegistryPath } from "../src/config/paths/index.ts";

describe("WorkspaceStore", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	function createTempDir(prefix: string): string {
		const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
		return dir;
	}

	it("persists a display alias without changing identity or any directory", () => {
		const agentDir = createTempDir("myharness-alias-agent");
		const dataRoot = createTempDir("myharness-alias-data");
		const projectDir = createTempDir("myharness-alias-project");
		const store = WorkspaceStore.create(agentDir, dataRoot);
		const original = store.add(projectDir).workspace!;
		expect(store.rename(original.workspaceId, "  Friendly project  ")).toBe(true);
		const reloaded = WorkspaceStore.create(agentDir, dataRoot).getById(original.workspaceId)!;
		expect(reloaded).toEqual({ ...original, name: "Friendly project" });
		expect(existsSync(projectDir)).toBe(true);
		expect(store.rename(original.workspaceId, "  ")).toBe(false);
		expect(store.rename("missing", "Name")).toBe(false);
		expect(store.getById(original.workspaceId)!.name).toBe("Friendly project");
	});

	describe("add", () => {
		it("adds a workspace and persists it", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const projectDir = createTempDir("myharness-workspace-project");
			const store = WorkspaceStore.create(agentDir);

			const result = store.add(projectDir);
			expect(result.ok).toBe(true);
			expect(result.workspace).toBeDefined();
			expect(result.workspace!.rootPath).toBe(projectDir);
			expect(result.workspace!.name).toBe(projectDir.split(/[\\/]/).pop());
			expect(result.workspace!.id).toBe(projectDir);
			expect(result.workspace!.createdAt).toBeTruthy();

			// Persisted to disk and reloadable.
			expect(existsSync(getWorkspacesPath(agentDir))).toBe(true);
			const reloaded = WorkspaceStore.create(agentDir);
			expect(reloaded.list()).toHaveLength(1);
			expect(reloaded.list()[0]!.rootPath).toBe(projectDir);
		});

		it("rejects a path that does not exist", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const store = WorkspaceStore.create(agentDir);
			const missing = join(agentDir, "does-not-exist");
			const result = store.add(missing);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("路径不存在");
			expect(store.list()).toHaveLength(0);
		});

		it("rejects a file (not a directory)", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const filePath = join(agentDir, "file.txt");
			writeFileSync(filePath, "x");
			const store = WorkspaceStore.create(agentDir);
			const result = store.add(filePath);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("不是目录");
		});

		it("rejects an empty input", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const store = WorkspaceStore.create(agentDir);
			expect(store.add("   ").ok).toBe(false);
		});

		it("rejects duplicates (case-insensitively on Windows)", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const projectDir = createTempDir("myharness-workspace-project");
			const store = WorkspaceStore.create(agentDir);

			expect(store.add(projectDir).ok).toBe(true);
			const duplicate = store.add(projectDir);
			expect(duplicate.ok).toBe(false);
			expect(duplicate.error).toContain("已添加");

			if (process.platform === "win32") {
				const upper = projectDir.toUpperCase();
				const caseDuplicate = store.add(upper);
				expect(caseDuplicate.ok).toBe(false);
				expect(caseDuplicate.error).toContain("已添加");
			}
			expect(store.list()).toHaveLength(1);
		});

		it("accepts the filesystem root directory", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const store = WorkspaceStore.create(agentDir);
			const root = process.platform === "win32" ? "C:\\" : "/";
			const result = store.add(root);
			expect(result.ok).toBe(true);
			expect(result.workspace!.rootPath).toBeTruthy();
			expect(result.workspace!.name.length).toBeGreaterThan(0);
		});

		it("resolves relative paths against the provided base directory", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const projectDir = createTempDir("myharness-workspace-project");
			const store = WorkspaceStore.create(agentDir);

			const result = store.add(".", projectDir);
			expect(result.ok).toBe(true);
			expect(result.workspace!.rootPath).toBe(projectDir);
		});
	});

	describe("remove", () => {
		it("removes a workspace and persists the change", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const projectA = createTempDir("myharness-workspace-a");
			const projectB = createTempDir("myharness-workspace-b");
			const store = WorkspaceStore.create(agentDir);
			store.add(projectA);
			store.add(projectB);
			expect(store.list()).toHaveLength(2);

			expect(store.remove(projectA)).toBe(true);
			expect(store.list().map((w) => w.rootPath)).toEqual([projectB]);

			const reloaded = WorkspaceStore.create(agentDir);
			expect(reloaded.list().map((w) => w.rootPath)).toEqual([projectB]);
		});

		it("returns false for an unknown id", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const store = WorkspaceStore.create(agentDir);
			expect(store.remove("nope")).toBe(false);
		});
	});

	describe("relocateUnderRoot", () => {
		it("updates registered workspace roots below a moved repository", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			const repositoryRoot = createTempDir("myharness-workspace-repository");
			const nestedWorkspace = join(repositoryRoot, "packages", "app");
			const destinationParent = createTempDir("myharness-workspace-destination");
			const relocatedRoot = join(destinationParent, "renamed-repository");
			const outsideWorkspace = createTempDir("myharness-workspace-outside");
			mkdirSync(nestedWorkspace, { recursive: true });
			const store = WorkspaceStore.create(agentDir);
			expect(store.add(repositoryRoot).ok).toBe(true);
			expect(store.add(nestedWorkspace).ok).toBe(true);
			expect(store.add(outsideWorkspace).ok).toBe(true);

			renameSync(repositoryRoot, relocatedRoot);
			const result = store.relocateUnderRoot(repositoryRoot, relocatedRoot);

			expect(result.ok).toBe(true);
			expect(result.workspaces?.map((workspace) => workspace.rootPath)).toEqual([
				relocatedRoot,
				join(relocatedRoot, "packages", "app"),
			]);
			expect(store.list().map((workspace) => workspace.rootPath)).toEqual([
				relocatedRoot,
				join(relocatedRoot, "packages", "app"),
				outsideWorkspace,
			]);
			expect(store.list()[0]?.name).toBe("renamed-repository");
			expect(store.list()[1]?.name).toBe("app");
			expect(
				WorkspaceStore.create(agentDir)
					.list()
					.map((workspace) => workspace.rootPath),
			).toEqual([relocatedRoot, join(relocatedRoot, "packages", "app"), outsideWorkspace]);
		});
	});

	describe("corrupted file", () => {
		it("starts with an empty list when the file is not valid JSON", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			writeFileSync(getWorkspacesPath(agentDir), "{ not json");
			const store = WorkspaceStore.create(agentDir);
			expect(store.list()).toEqual([]);
			// A subsequent add recovers the file.
			const projectDir = createTempDir("myharness-workspace-project");
			expect(store.add(projectDir).ok).toBe(true);
			expect(WorkspaceStore.create(agentDir).list()).toHaveLength(1);
		});

		it("drops invalid entries but keeps valid ones", () => {
			const agentDir = createTempDir("myharness-workspace-store");
			writeFileSync(
				getWorkspacesPath(agentDir),
				JSON.stringify({
					version: 1,
					workspaces: [
						{ id: "ok", name: "ok", rootPath: "ok", createdAt: "2025-01-01T00:00:00.000Z" },
						{ id: "bad" },
						null,
					],
				}),
			);
			const store = WorkspaceStore.create(agentDir);
			expect(store.list()).toHaveLength(1);
			expect(store.list()[0]!.id).toBe("ok");
		});
	});

	describe("data-root consistency", () => {
		it("repairs missing metadata from the authoritative registry without registering orphans", () => {
			const agentDir = createTempDir("myharness-workspace-agent");
			const dataRoot = createTempDir("myharness-workspace-data");
			const projectDir = createTempDir("myharness-workspace-project");
			const workspaceId = "workspace-1";
			mkdirSync(join(dataRoot, "workspaces"), { recursive: true });
			writeFileSync(
				getWorkspaceRegistryPath(dataRoot),
				JSON.stringify({
					version: 2,
					workspaces: [
						{
							workspaceId,
							name: "project",
							rootPath: projectDir,
							createdAt: "2026-09-18T00:00:00.000Z",
						},
					],
				}),
			);
			const orphanId = "orphan-1";
			mkdirSync(join(dataRoot, "workspaces", orphanId, "metadata"), { recursive: true });
			writeFileSync(
				getWorkspaceMetadataPath(dataRoot, orphanId),
				JSON.stringify({
					version: 1,
					workspace: { workspaceId: orphanId, name: "orphan", rootPath: projectDir, createdAt: "now" },
				}),
			);

			const store = WorkspaceStore.create(agentDir, dataRoot);
			expect(store.list().map((workspace) => workspace.workspaceId)).toEqual([workspaceId]);
			expect(existsSync(getWorkspaceMetadataPath(dataRoot, workspaceId))).toBe(true);
			expect(store.getConsistencyIssues()).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "missing_metadata", status: "repaired" })]),
			);
		});

		it("reports a missing workspace root while retaining the registry record", () => {
			const agentDir = createTempDir("myharness-workspace-agent");
			const dataRoot = createTempDir("myharness-workspace-data");
			const missingRoot = join(dataRoot, "does-not-exist");
			mkdirSync(join(dataRoot, "workspaces"), { recursive: true });
			writeFileSync(
				getWorkspaceRegistryPath(dataRoot),
				JSON.stringify({
					version: 2,
					workspaces: [
						{
							workspaceId: "workspace-2",
							name: "missing",
							rootPath: missingRoot,
							createdAt: "2026-09-18T00:00:00.000Z",
						},
					],
				}),
			);

			const store = WorkspaceStore.create(agentDir, dataRoot);
			expect(store.list()).toHaveLength(1);
			expect(store.getConsistencyIssues()).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "missing_root", status: "unresolved" })]),
			);
		});
	});
});

describe("validateWorkspacePath", () => {
	it("rejects an empty string", () => {
		const result = validateWorkspacePath("  ", process.cwd());
		expect("error" in result).toBe(true);
	});

	it("accepts an existing directory", () => {
		const result = validateWorkspacePath(process.cwd(), process.cwd());
		expect("rootPath" in result).toBe(true);
		if ("rootPath" in result) {
			expect(result.rootPath).toBe(process.cwd());
		}
	});
});
