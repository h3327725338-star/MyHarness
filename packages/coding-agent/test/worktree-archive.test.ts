import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoArchiveReason, isInsideDirectory, WorktreeArchiveRecords } from "../src/git/worktrees/archive-records.ts";

let agentDir = "";
let tempDir = "";

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "myharness-archive-store-"));
	tempDir = join(agentDir, "os-temp");
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

/** A copy path that exists on disk, so pruning keeps its record. */
function existingCopy(name: string): string {
	const path = join(agentDir, "worktrees", "repo", name);
	mkdirSync(path, { recursive: true });
	return path;
}

describe("autoArchiveReason", () => {
	const base = () => ({ isMain: false, tempDir });

	it("never archives the main copy", () => {
		expect(
			autoArchiveReason({ ...base(), path: join(tempDir, "copy"), isMain: true, branch: undefined }),
		).toBeUndefined();
	});

	it("keeps copies the app created on purpose", () => {
		expect(
			autoArchiveReason({
				...base(),
				path: join(agentDir, "copy"),
				branch: "task-0101-0900",
				record: { path: join(agentDir, "copy"), origin: "manual" },
			}),
		).toBeUndefined();
	});

	it("archives sub-agent copies and copies marked as external", () => {
		const subagentPath = join(agentDir, "worktrees", "repo", "sub");
		expect(
			autoArchiveReason({
				...base(),
				path: subagentPath,
				branch: "myharness-subagent-abc",
				record: { path: subagentPath, origin: "subagent" },
			}),
		).toBe("subagent");
		const externalPath = join(agentDir, "elsewhere");
		expect(
			autoArchiveReason({
				...base(),
				path: externalPath,
				branch: "bench",
				record: { path: externalPath, origin: "external" },
			}),
		).toBe("temporary");
	});

	it("recognises a sub-agent copy that predates the archived origins by its generated branch", () => {
		expect(
			autoArchiveReason({ ...base(), path: existingCopy("old-sub"), branch: "myharness-subagent-0123456789" }),
		).toBe("subagent");
	});

	it("treats a detached copy or one inside the OS temporary directory as a script leftover", () => {
		const detached = existingCopy("detached");
		expect(autoArchiveReason({ ...base(), path: detached, branch: undefined })).toBe("temporary");
		expect(autoArchiveReason({ ...base(), path: join(tempDir, "bench-1"), branch: "bench" })).toBe("temporary");
	});

	it("leaves a branch-backed copy outside the temporary directory alone", () => {
		expect(autoArchiveReason({ ...base(), path: existingCopy("mine"), branch: "feature/x" })).toBeUndefined();
	});

	it("does not re-archive a copy that is already archived", () => {
		const path = existingCopy("done");
		expect(
			autoArchiveReason({
				...base(),
				path,
				branch: "myharness-subagent-abc",
				record: { path, origin: "subagent", archivedAt: "2026-10-20T00:00:00.000Z" },
			}),
		).toBeUndefined();
	});
});

describe("isInsideDirectory", () => {
	it("matches a child but not a sibling with a shared prefix", () => {
		expect(isInsideDirectory(join(tempDir, "run-1"), tempDir)).toBe(true);
		expect(isInsideDirectory(tempDir, tempDir)).toBe(true);
		expect(isInsideDirectory(`${tempDir}-other`, tempDir)).toBe(false);
	});
});

describe("WorktreeArchiveRecords", () => {
	it("merges patches, clears fields and keeps the copy path inside the record", () => {
		const path = existingCopy("copy");
		const records = new WorktreeArchiveRecords(agentDir);
		records.update(path, { origin: "subagent" });
		expect(records.get(path)).toEqual({ path, origin: "subagent" });

		records.update(path, {
			archivedAt: "2026-10-20T00:00:00.000Z",
			reason: "subagent",
			branch: "myharness-subagent-abc",
		});
		expect(records.get(path)).toEqual({
			path,
			origin: "subagent",
			archivedAt: "2026-10-20T00:00:00.000Z",
			reason: "subagent",
			branch: "myharness-subagent-abc",
		});

		// Restoring clears the archive fields but remembers who made the copy.
		records.update(path, { archivedAt: undefined, reason: undefined });
		expect(records.get(path)).toEqual({ path, origin: "subagent", branch: "myharness-subagent-abc" });
	});

	it("drops records whose copy no longer exists", () => {
		const alive = existingCopy("alive");
		const records = new WorktreeArchiveRecords(agentDir);
		records.update(alive, { origin: "manual" });
		records.update(join(agentDir, "worktrees", "repo", "gone"), {
			origin: "subagent",
			archivedAt: "2026-10-20T00:00:00.000Z",
		});

		records.prune();
		expect(records.get(alive)).toMatchObject({ origin: "manual" });
		expect(records.get(join(agentDir, "worktrees", "repo", "gone"))).toBeUndefined();
	});

	it("ignores a corrupted record instead of failing the copy list", () => {
		const path = existingCopy("broken");
		const records = new WorktreeArchiveRecords(agentDir);
		records.update(path, { origin: "manual" });
		const file = join(agentDir, "worktrees", "archive");
		const name = readdirSync(file)[0] ?? "";
		writeFileSync(join(file, name), "{not json");
		expect(new WorktreeArchiveRecords(agentDir).get(path)).toBeUndefined();
	});
});
