import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacySessionsToDataDir } from "../src/session/migrations/storage.ts";

describe("legacy Session storage migration", () => {
	const temporaryRoots: string[] = [];

	afterEach(() => {
		for (const root of temporaryRoots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});

	function createTemporaryRoot(): string {
		const root = join(tmpdir(), `myharness-session-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		temporaryRoots.push(root);
		mkdirSync(root, { recursive: true });
		return root;
	}

	it("copies the complete tree, rewrites persisted references, and removes verified sources", () => {
		const root = createTemporaryRoot();
		const sourceRoot = join(root, "old", "sessions");
		const targetRoot = join(root, "project", "data", "sessions");
		const sessionDir = join(sourceRoot, "--C--project--");
		const parentFile = join(sessionDir, "2026-09-17T10-00-00-000Z_parent.jsonl");
		const childFile = join(sessionDir, "2026-09-17T10-01-00-000Z_child.jsonl");
		const outputFile = join(sessionDir, "tool-results", "child", "output.txt");
		mkdirSync(dirname(outputFile), { recursive: true });
		writeFileSync(
			parentFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "parent-session",
				timestamp: "2026-09-17T10:00:00.000Z",
				cwd: "C:\\project",
			})}\n`,
		);
		writeFileSync(
			childFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: "2026-09-17T10:01:00.000Z",
					cwd: "C:\\project",
					parentSession: parentFile,
				}),
				JSON.stringify({ type: "tool_result", message: { details: { fullOutputPath: outputFile } } }),
				"",
			].join("\n"),
		);
		writeFileSync(outputFile, "tool output\n");
		const parentMtime = statSync(parentFile).mtimeMs;

		const result = migrateLegacySessionsToDataDir(root, { sourceRoot, targetRoot });

		expect(result.sourceExists).toBe(true);
		expect(result.copiedFiles).toBe(3);
		expect(result.removedSourceFiles).toBe(3);
		expect(result.rewrittenPathFields).toBe(2);
		expect(result.conflicts).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(result.unresolvedReferences).toEqual([]);
		expect(existsSync(parentFile)).toBe(false);
		expect(existsSync(childFile)).toBe(false);
		expect(existsSync(outputFile)).toBe(false);

		const targetParent = join(targetRoot, "--C--project--", "2026-09-17T10-00-00-000Z_parent.jsonl");
		const targetChild = join(targetRoot, "--C--project--", "2026-09-17T10-01-00-000Z_child.jsonl");
		const targetOutput = join(targetRoot, "--C--project--", "tool-results", "child", "output.txt");
		expect(existsSync(targetParent)).toBe(true);
		expect(existsSync(targetChild)).toBe(true);
		expect(existsSync(targetOutput)).toBe(true);
		expect(existsSync(join(targetRoot, ".legacy-session-storage-migrated.json"))).toBe(true);
		const childEntries = readFileSync(targetChild, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(childEntries[0]?.parentSession).toBe(targetParent);
		expect((childEntries[1]?.message as { details?: { fullOutputPath?: string } })?.details?.fullOutputPath).toBe(
			targetOutput,
		);
		expect(Math.abs(statSync(targetParent).mtimeMs - parentMtime)).toBeLessThan(2);

		const secondRun = migrateLegacySessionsToDataDir(root, { sourceRoot, targetRoot });
		expect(secondRun.sourceExists).toBe(false);
		expect(secondRun.copiedFiles).toBe(0);
		expect(secondRun.errors).toEqual([]);
	});

	it("keeps both files when the target contains different data", () => {
		const root = createTemporaryRoot();
		const sourceRoot = join(root, "old", "sessions");
		const targetRoot = join(root, "project", "data", "sessions");
		const relativeFile = join("--C--project--", "2026-09-17T10-00-00-000Z_conflict.jsonl");
		const sourceFile = join(sourceRoot, relativeFile);
		const targetFile = join(targetRoot, relativeFile);
		mkdirSync(join(sourceRoot, "--C--project--"), { recursive: true });
		mkdirSync(join(targetRoot, "--C--project--"), { recursive: true });
		writeFileSync(
			sourceFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "source-session",
				timestamp: "2026-09-17T10:00:00.000Z",
				cwd: "C:\\project",
			})}\n`,
		);
		writeFileSync(targetFile, "different target data\n");

		const result = migrateLegacySessionsToDataDir(root, { sourceRoot, targetRoot });

		expect(result.copiedFiles).toBe(0);
		expect(result.removedSourceFiles).toBe(0);
		expect(result.conflicts).toContain(targetFile);
		expect(existsSync(sourceFile)).toBe(true);
		expect(readFileSync(targetFile, "utf8")).toBe("different target data\n");
	});
});

function dirname(path: string): string {
	return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
}
