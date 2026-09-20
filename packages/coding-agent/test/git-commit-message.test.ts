import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateCommitMessageForPaths, generateInitialCommitMessage } from "../src/git/commits/message.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";

const gitAvailable = runGit(process.cwd(), ["--version"]).ok;
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function createRepository(): string {
	const project = createTemporaryDirectory("myharness-git-commit-msg-");
	writeFileSync(join(project, "tracked.txt"), "initial tracked\n", "utf8");
	expect(initializeGitRepository(project).ok).toBe(true);
	expect(
		setLocalGitIdentity(project, { name: "MyHarness Commit Message Test", email: "commit-msg@example.invalid" }).ok,
	).toBe(true);
	expect(createInitialGitBaseline(project).ok).toBe(true);
	return project;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	}
});

describe.skipIf(!gitAvailable)("generateCommitMessageForPaths", () => {
	it("describes a modified file with status, path, and line stats", () => {
		const project = createRepository();
		writeFileSync(join(project, "tracked.txt"), "initial tracked\nnew line\n", "utf8");

		const message = generateCommitMessageForPaths(project, ["tracked.txt"]);

		expect(message.title).toMatch(/^chore: 更新 tracked/);
		expect(message.body.some((line) => line.startsWith("- M tracked.txt (+1/-0)"))).toBe(true);
		expect(message.full).toContain(message.title);
	});

	it("infers feat for newly added files", () => {
		const project = createRepository();
		writeFileSync(join(project, "feature.ts"), "export function hello(): void {}\n", "utf8");

		const message = generateCommitMessageForPaths(project, ["feature.ts"]);

		expect(message.title).toMatch(/^feat: 新增 feature/);
		expect(message.body.some((line) => line.startsWith("- A feature.ts"))).toBe(true);
	});

	it("infers test type when most changed paths are tests", () => {
		const project = createRepository();
		writeFileSync(join(project, "tracked.test.ts"), "it('works', () => {});\n", "utf8");
		writeFileSync(join(project, "helper.ts"), "export const x = 1;\n", "utf8");

		const message = generateCommitMessageForPaths(project, ["tracked.test.ts", "helper.ts"]);

		expect(message.title).toMatch(/^test:/);
	});

	it("infers docs type for markdown files", () => {
		const project = createRepository();
		writeFileSync(join(project, "README.md"), "# Updated\n", "utf8");

		const message = generateCommitMessageForPaths(project, ["README.md"]);

		expect(message.title).toMatch(/^docs: 更新文档/);
	});

	it("infers fix when the diff contains fix keywords", () => {
		const project = createRepository();
		writeFileSync(join(project, "tracked.txt"), "initial tracked\n修复了超时问题\n", "utf8");

		const message = generateCommitMessageForPaths(project, ["tracked.txt"]);

		expect(message.title).toMatch(/^fix:/);
	});

	it("infers scope from the packages directory", () => {
		const project = createRepository();
		const demoDir = join(project, "packages", "coding-agent", "src", "tools");
		mkdirSync(demoDir, { recursive: true });
		writeFileSync(join(demoDir, "demo.ts"), "export const a = 1;\n", "utf8");

		const message = generateCommitMessageForPaths(project, ["packages/coding-agent/src/tools/demo.ts"]);

		expect(message.title).toMatch(/^feat\(coding-agent\): 新增 demo/);
	});

	it("extracts changed function names from the diff into the body", () => {
		const project = createRepository();
		writeFileSync(join(project, "mod.ts"), "export function addedFunction(): void {}\n", "utf8");

		const message = generateCommitMessageForPaths(project, ["mod.ts"]);

		expect(message.body.some((line) => line.includes("addedFunction()"))).toBe(true);
	});

	it("handles deleted files", () => {
		const project = createRepository();
		runGit(project, ["rm", "tracked.txt"]);

		const message = generateCommitMessageForPaths(project, ["tracked.txt"]);

		expect(message.body.some((line) => line.startsWith("- D tracked.txt"))).toBe(true);
	});
});

describe.skipIf(!gitAvailable)("generateInitialCommitMessage", () => {
	it("lists staged files for the initial commit", () => {
		const project = createTemporaryDirectory("myharness-git-commit-msg-init-");
		writeFileSync(join(project, "a.txt"), "a\n", "utf8");
		writeFileSync(join(project, "b.txt"), "b\n", "utf8");
		expect(initializeGitRepository(project).ok).toBe(true);
		expect(
			setLocalGitIdentity(project, { name: "MyHarness Commit Message Test", email: "commit-msg@example.invalid" })
				.ok,
		).toBe(true);
		expect(runGit(project, ["add", "-A"]).ok).toBe(true);

		const message = generateInitialCommitMessage(project);

		expect(message.title).toMatch(/^chore: 建立项目初始版本（2 个文件）$/);
		expect(message.body.some((line) => line.includes("a.txt"))).toBe(true);
		expect(message.body.some((line) => line.includes("b.txt"))).toBe(true);
	});
});
