import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	beginRepositoryDirectoryMove,
	deleteLocalGitRepositoryMetadata,
	getLocalGitRepositoriesPath,
	initializeManagedLocalGitRepository,
	inspectLocalGitRepositoryPath,
	LocalGitRepositoryStore,
	selectLocalGitRepository,
} from "../src/git/local-repositories/store.ts";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!gitAvailable)("LocalGitRepositoryStore", () => {
	const cleanups: string[] = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			const path = cleanups.pop()!;
			if (existsSync(path)) rmSync(path, { recursive: true, force: true });
		}
	});

	function createTempDir(prefix: string): string {
		const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
		cleanups.push(path);
		return path;
	}

	it("uses the Git root for an explicitly selected nested folder", () => {
		const agentDir = createTempDir("myharness-local-git-agent");
		const repositoryRoot = createTempDir("myharness-local-git-repository");
		const nestedPath = join(repositoryRoot, "nested");
		mkdirSync(nestedPath);
		expect(initializeManagedLocalGitRepository(repositoryRoot).ok).toBe(true);

		const store = LocalGitRepositoryStore.create(agentDir);
		const result = selectLocalGitRepository(store, nestedPath, repositoryRoot, false);

		expect(result.ok).toBe(true);
		expect(result.repository?.rootPath).toBe(repositoryRoot);
		expect(store.list()).toHaveLength(1);
		expect(store.list()[0]?.rootPath).toBe(repositoryRoot);
	});

	it("requires an explicit second confirmation before initializing a normal folder", () => {
		const agentDir = createTempDir("myharness-local-git-agent");
		const directory = createTempDir("myharness-local-git-directory");
		const store = LocalGitRepositoryStore.create(agentDir);

		const requiresInitialization = selectLocalGitRepository(store, directory, directory, false);
		expect(requiresInitialization).toMatchObject({
			ok: false,
			requiresInitialization: true,
			rootPath: directory,
		});
		expect(existsSync(join(directory, ".git"))).toBe(false);

		const initialized = selectLocalGitRepository(store, directory, directory, true);
		expect(initialized.ok).toBe(true);
		expect(initialized.repository?.rootPath).toBe(directory);
		expect(inspectLocalGitRepositoryPath(directory)).toEqual({ kind: "repository", rootPath: directory });
		expect(LocalGitRepositoryStore.create(agentDir).list()).toHaveLength(1);
		expect(existsSync(getLocalGitRepositoriesPath(agentDir))).toBe(true);
	});

	it("deletes only .git and preserves the project directory and files", () => {
		const repositoryRoot = createTempDir("myharness-local-git-delete");
		const projectFile = join(repositoryRoot, "project.txt");
		writeFileSync(projectFile, "keep this file");
		expect(initializeManagedLocalGitRepository(repositoryRoot).ok).toBe(true);

		const result = deleteLocalGitRepositoryMetadata(repositoryRoot);

		expect(result).toEqual({ ok: true, removed: true });
		expect(existsSync(repositoryRoot)).toBe(true);
		expect(existsSync(projectFile)).toBe(true);
		expect(existsSync(join(repositoryRoot, ".git"))).toBe(false);
		expect(inspectLocalGitRepositoryPath(repositoryRoot)).toEqual({ kind: "directory", rootPath: repositoryRoot });
	});

	it("recognizes externally deleted directories as missing without recreating them", () => {
		const agentDir = createTempDir("myharness-local-git-agent");
		const repositoryRoot = createTempDir("myharness-local-git-external-delete");
		expect(initializeManagedLocalGitRepository(repositoryRoot).ok).toBe(true);
		const store = LocalGitRepositoryStore.create(agentDir);
		expect(selectLocalGitRepository(store, repositoryRoot, repositoryRoot, false).ok).toBe(true);

		rmSync(repositoryRoot, { recursive: true, force: true });

		expect(inspectLocalGitRepositoryPath(repositoryRoot)).toEqual({ kind: "missing", rootPath: repositoryRoot });
		expect(deleteLocalGitRepositoryMetadata(repositoryRoot)).toEqual({ ok: true, removed: false });
		expect(existsSync(repositoryRoot)).toBe(false);
		expect(store.list()[0]?.rootPath).toBe(repositoryRoot);
	});

	it("moves a repository reversibly and persists its new registry location only after commit", () => {
		const agentDir = createTempDir("myharness-local-git-agent");
		const root = createTempDir("myharness-local-git-move-root");
		const source = join(root, "source");
		const destinationParent = join(root, "destination-parent");
		const destination = join(destinationParent, "renamed");
		mkdirSync(source);
		mkdirSync(destinationParent);
		writeFileSync(join(source, "project.txt"), "project contents");
		expect(initializeManagedLocalGitRepository(source).ok).toBe(true);

		const store = LocalGitRepositoryStore.create(agentDir);
		const repository = store.add(source).repository!;
		const rollbackTransaction = beginRepositoryDirectoryMove(source, destination);
		expect(existsSync(source)).toBe(false);
		expect(existsSync(destination)).toBe(true);
		rollbackTransaction.rollback();
		expect(existsSync(source)).toBe(true);
		expect(existsSync(destination)).toBe(false);

		const transaction = beginRepositoryDirectoryMove(source, destination);
		const update = store.updateLocation(repository.id, destination);
		expect(update.ok).toBe(true);
		transaction.commit();

		expect(existsSync(source)).toBe(false);
		expect(existsSync(join(destination, "project.txt"))).toBe(true);
		expect(inspectLocalGitRepositoryPath(destination)).toEqual({ kind: "repository", rootPath: destination });
		expect(LocalGitRepositoryStore.create(agentDir).list()[0]?.rootPath).toBe(destination);
	});

	it("does not change the source when the destination already exists", () => {
		const root = createTempDir("myharness-local-git-move-conflict");
		const source = join(root, "source");
		const destination = join(root, "destination");
		mkdirSync(source);
		mkdirSync(destination);
		writeFileSync(join(source, "project.txt"), "project contents");

		expect(() => beginRepositoryDirectoryMove(source, destination)).toThrow("目标路径已存在");
		expect(existsSync(source)).toBe(true);
		expect(existsSync(join(source, "project.txt"))).toBe(true);
		expect(existsSync(destination)).toBe(true);
	});

	it.skipIf(process.platform !== "win32")("supports a case-only repository folder rename on Windows", () => {
		const root = createTempDir("myharness-local-git-case-rename");
		const source = join(root, "repository");
		const destination = join(root, "Repository");
		mkdirSync(source);
		writeFileSync(join(source, "project.txt"), "project contents");

		const transaction = beginRepositoryDirectoryMove(source, destination);
		transaction.commit();

		expect(existsSync(join(destination, "project.txt"))).toBe(true);
	});
});
