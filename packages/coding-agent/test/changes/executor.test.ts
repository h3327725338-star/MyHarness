import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Journal } from "../../src/changes/change-store.ts";
import { buildChangeset } from "../../src/changes/changeset.ts";
import { ChangeControlError } from "../../src/changes/errors.ts";
import { type ChangeFs, defaultChangeFs } from "../../src/changes/executor.ts";
import { sha256 } from "../../src/changes/text-file.ts";
import { getMutationQueueKey, withFileMutationQueue } from "../../src/tools/files/file-mutation-queue.ts";
import {
	createExecutor,
	createTestWorkspace,
	disposeTestWorkspaces,
	modification,
	permitFor,
	planOf,
	type TestWorkspace,
} from "./helpers.ts";

afterEach(() => {
	vi.useRealTimers();
	disposeTestWorkspaces();
});

const FILES = {
	"src/a.ts": "export const a = 1;\n",
	"src/b.ts": "export const b = 2;\n",
	"src/c.ts": "export const c = 3;\n",
};
const AFTER = {
	"src/a.ts": "export const a = 10;\n",
	"src/b.ts": "export const b = 20;\n",
	"src/c.ts": "export const c = 30;\n",
};

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof ChangeControlError ? error.code : `other:${String(error)}`;
	}
	return undefined;
}

async function prepared(workspace: TestWorkspace, executorOptions: Parameters<typeof createExecutor>[1] = {}) {
	const { store, executor } = createExecutor(workspace, executorOptions);
	const built = await planOf(workspace, AFTER);
	await store.saveChangeset(built);
	const permit = await permitFor(store, built);
	return { store, executor, built, permit };
}

/** The default file operations with a hook that runs before the nth write (1-based). */
function faultyFs(onWrite: (call: number, path: string) => Promise<void> | void): ChangeFs {
	let calls = 0;
	return {
		read: defaultChangeFs.read,
		remove: defaultChangeFs.remove,
		async write(path, bytes) {
			calls++;
			await onWrite(calls, path);
			return defaultChangeFs.write(path, bytes);
		},
	};
}

function snapshot(workspace: TestWorkspace): Record<string, string> {
	return Object.fromEntries(Object.keys(FILES).map((path) => [path, workspace.readText(path)]));
}

describe("cancelling while the files are busy", () => {
	it("changes nothing, reports CANCELLED and keeps the permit for a later try", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store, executor, built, permit } = await prepared(workspace);
		const path = workspace.abs("src/a.ts");
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holder = withFileMutationQueue(path, () => held);
		const controller = new AbortController();

		const attempt = codeOf(executor.apply(built.changeset.id, { permitId: permit.id, signal: controller.signal }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		controller.abort();

		expect(await attempt).toBe("CANCELLED");
		expect(snapshot(workspace)).toEqual(FILES);
		expect(store.permitUsed(permit.id)).toBe(false);
		release();
		await holder;
		await executor.apply(built.changeset.id, { permitId: permit.id });
		expect(snapshot(workspace)).toEqual(AFTER);
	});
});

describe("ChangeExecutor.apply", () => {
	it("commits every file, records a journal, drops the before images and consumes the permit", async () => {
		const workspace = createTestWorkspace(FILES);
		const onCommitted = vi.fn();
		const { store, executor, built, permit } = await prepared(workspace, { onCommitted });

		const result = await executor.apply(built.changeset.id, { permitId: permit.id });

		expect(snapshot(workspace)).toEqual(AFTER);
		expect(result.status).toBe("committed");
		expect(
			result.files.map((file) => [file.path, file.afterHash === sha256(AFTER[file.path as keyof typeof AFTER])]),
		).toEqual([
			["src/a.ts", true],
			["src/b.ts", true],
			["src/c.ts", true],
		]);
		const journal = store.readJournal(built.changeset.id) as Journal;
		expect(journal.state).toBe("committed");
		expect(journal.entries.every((entry) => entry.state === "committed")).toBe(true);
		expect(existsSync(join(store.root, "journals", built.changeset.id))).toBe(false);
		expect(store.permitUsed(permit.id)).toBe(true);
		expect(onCommitted).toHaveBeenCalledTimes(1);
		expect(result.committedAfterCancel).toBe(false);
	});

	it("rejects a replay of the same permit and cannot apply the same plan twice", async () => {
		const workspace = createTestWorkspace(FILES);
		const { executor, built, permit } = await prepared(workspace);
		await executor.apply(built.changeset.id, { permitId: permit.id });

		expect(await codeOf(executor.apply(built.changeset.id, { permitId: permit.id }))).toBe("PERMIT_INVALID");
		expect(snapshot(workspace)).toEqual(AFTER);
	});

	it("binds a permit to one changeset, its files and hashes, its workspace and its lifetime", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store, executor, built } = await prepared(workspace);
		const other = await planOf(workspace, { "src/a.ts": "export const a = 99;\n" });
		await store.saveChangeset(other);

		const forOther = await permitFor(store, other);
		expect(await codeOf(executor.apply(built.changeset.id, { permitId: forOther.id }))).toBe("PERMIT_INVALID");

		const widened = await permitFor(store, built, {
			files: built.changeset.files.map((file) => ({ ...file, afterHash: "0".repeat(64) })),
		});
		expect(await codeOf(executor.apply(built.changeset.id, { permitId: widened.id }))).toBe("PERMIT_INVALID");

		const expired = await permitFor(store, built, { expiresAt: Date.now() - 1 });
		expect(await codeOf(executor.apply(built.changeset.id, { permitId: expired.id }))).toBe("PERMIT_INVALID");

		const elsewhere = await permitFor(store, built, { workspaceRoot: "C:\\somewhere\\else" });
		expect(await codeOf(executor.apply(built.changeset.id, { permitId: elsewhere.id }))).toBe("PERMIT_INVALID");

		expect(
			await codeOf(executor.apply(built.changeset.id, { permitId: "11111111-1111-1111-1111-111111111111" })),
		).toBe("PERMIT_REQUIRED");
		expect(snapshot(workspace)).toEqual(FILES);
	});

	it("refuses ids that are not ids before they can become paths", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store, executor } = createExecutor(workspace);

		expect(await codeOf(executor.apply("../../etc/passwd", { permitId: "x" }))).toBe("NOT_FOUND");
		expect(() => store.loadPermit("..\\..\\x")).toThrow(ChangeControlError);
		expect(await codeOf(executor.apply("a".repeat(32), { permitId: "11111111-1111-1111-1111-111111111111" }))).toBe(
			"NOT_FOUND",
		);
	});

	it("refuses a plan whose files changed since it was made, touching nothing and keeping the permit usable", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store, executor, built, permit } = await prepared(workspace);
		workspace.write("src/b.ts", "export const b = 'edited by someone';\n");

		expect(await codeOf(executor.apply(built.changeset.id, { permitId: permit.id }))).toBe("EDIT_CONFLICT");

		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
		expect(workspace.readText("src/b.ts")).toBe("export const b = 'edited by someone';\n");
		expect(store.permitUsed(permit.id)).toBe(false);
	});

	it("restores exactly what it wrote when a later file was changed by someone else mid-apply", async () => {
		const workspace = createTestWorkspace(FILES);
		const fs = faultyFs((call) => {
			if (call === 2) workspace.write("src/c.ts", "export const c = 'user typed this';\n");
		});
		const { store, executor, built, permit } = await prepared(workspace, { fs });

		const failure = await executor
			.apply(built.changeset.id, { permitId: permit.id })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ChangeControlError);
		expect((failure as ChangeControlError).code).toBe("EDIT_CONFLICT");
		expect((failure as ChangeControlError).message).toContain("rolled back");
		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
		expect(workspace.readText("src/b.ts")).toBe(FILES["src/b.ts"]);
		expect(workspace.readText("src/c.ts")).toBe("export const c = 'user typed this';\n");
		expect((store.readJournal(built.changeset.id) as Journal).state).toBe("rolled_back");
	});

	it("rolls back when a write fails on the nth file", async () => {
		const workspace = createTestWorkspace(FILES);
		const fs = faultyFs((call) => {
			if (call === 3) throw new Error("disk full");
		});
		const { store, executor, built, permit } = await prepared(workspace, { fs });

		await expect(executor.apply(built.changeset.id, { permitId: permit.id })).rejects.toThrow("disk full");

		expect(snapshot(workspace)).toEqual(FILES);
		const journal = store.readJournal(built.changeset.id) as Journal;
		expect(journal.state).toBe("rolled_back");
		// The file whose write failed was never changed by this apply, so it has nothing to restore.
		expect(journal.entries.map((entry) => entry.state)).toEqual(["restored", "restored", "pending"]);
	});

	it("leaves a file alone that someone changed after this apply wrote it, and says so", async () => {
		const workspace = createTestWorkspace(FILES);
		const fs = faultyFs((call) => {
			if (call === 3) {
				workspace.write("src/a.ts", "export const a = 'user rewrote after our write';\n");
				throw new Error("disk full");
			}
		});
		const { store, executor, built, permit } = await prepared(workspace, { fs });
		// A later change over the same file, planned while the file is still as it was.
		const next = await planOf(workspace, { "src/a.ts": "export const a = 'next';\n" });
		await store.saveChangeset(next);
		const nextPermit = await permitFor(store, next);

		const failure = await executor
			.apply(built.changeset.id, { permitId: permit.id })
			.catch((error: unknown) => error);

		expect((failure as ChangeControlError).code).toBe("RECOVERY_CONFLICT");
		expect((failure as ChangeControlError).paths).toEqual(["src/a.ts"]);
		expect(workspace.readText("src/a.ts")).toBe("export const a = 'user rewrote after our write';\n");
		expect(workspace.readText("src/b.ts")).toBe(FILES["src/b.ts"]);
		expect((store.readJournal(built.changeset.id) as Journal).state).toBe("recovery_conflict");
		// The before images are kept while a conflict is open.
		expect(existsSync(join(store.root, "journals", built.changeset.id))).toBe(true);

		// New changes over the same file are blocked until the conflict is resolved.
		expect(await codeOf(executor.apply(next.changeset.id, { permitId: nextPermit.id }))).toBe("RECOVERY_CONFLICT");

		// Once the person puts the file back, recover closes the journal and work can continue.
		workspace.write("src/a.ts", FILES["src/a.ts"]);
		const reports = await executor.recover();
		expect(reports).toEqual([
			expect.objectContaining({ changesetId: built.changeset.id, outcome: "rolled_back", conflicts: [] }),
		]);
		expect((store.readJournal(built.changeset.id) as Journal).state).toBe("rolled_back");
		await expect(executor.apply(next.changeset.id, { permitId: nextPermit.id })).resolves.toMatchObject({
			status: "committed",
		});
	});

	it("finishes the rollback of a crashed attempt from its journal, exactly", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store, executor, built } = await prepared(workspace);
		// What a crash after the first two writes leaves behind: files a and b written, c untouched, journal applying.
		const entries = built.changeset.files.map((file, index) => ({
			index,
			path: file.path,
			absolutePath: file.absolutePath,
			key: file.key,
			operation: file.operation,
			beforeHash: file.baseHash,
			afterHash: file.afterHash,
			state: (index < 2 ? "committed" : "pending") as "committed" | "pending",
		}));
		for (const [index, file] of built.changeset.files.entries()) {
			await store.writeBefore(built.changeset.id, index, workspace.read(file.path));
		}
		await store.writeJournal({
			version: 1,
			changesetId: built.changeset.id,
			workspaceRoot: workspace.root,
			owner: { pid: 999_999, startedAt: Date.now() - 60_000 },
			state: "applying",
			updatedAt: Date.now(),
			entries,
		});
		workspace.write("src/a.ts", AFTER["src/a.ts"]);
		workspace.write("src/b.ts", AFTER["src/b.ts"]);

		const reports = await executor.recover();

		expect(reports).toEqual([
			expect.objectContaining({ outcome: "rolled_back", restored: ["src/b.ts", "src/a.ts"], conflicts: [] }),
		]);
		expect(snapshot(workspace)).toEqual(FILES);
		expect((store.readJournal(built.changeset.id) as Journal).state).toBe("rolled_back");
	});

	it("does not overwrite a file the person changed after a crash", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store, executor, built } = await prepared(workspace);
		for (const [index, file] of built.changeset.files.entries()) {
			await store.writeBefore(built.changeset.id, index, workspace.read(file.path));
		}
		await store.writeJournal({
			version: 1,
			changesetId: built.changeset.id,
			workspaceRoot: workspace.root,
			owner: { pid: 999_999, startedAt: Date.now() - 60_000 },
			state: "applying",
			updatedAt: Date.now(),
			entries: built.changeset.files.map((file, index) => ({
				index,
				path: file.path,
				absolutePath: file.absolutePath,
				key: file.key,
				operation: file.operation,
				beforeHash: file.baseHash,
				afterHash: file.afterHash,
				state: "committed" as const,
			})),
		});
		workspace.write("src/a.ts", AFTER["src/a.ts"]);
		workspace.write("src/b.ts", "export const b = 'the person edited this';\n");
		workspace.write("src/c.ts", AFTER["src/c.ts"]);

		const reports = await executor.recover();

		expect(reports[0]).toMatchObject({ outcome: "recovery_conflict", conflicts: ["src/b.ts"] });
		expect(workspace.readText("src/b.ts")).toBe("export const b = 'the person edited this';\n");
		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
		expect(workspace.readText("src/c.ts")).toBe(FILES["src/c.ts"]);
	});

	it("rolls back when cancelled part-way and says so", async () => {
		const workspace = createTestWorkspace(FILES);
		const controller = new AbortController();
		const fs = faultyFs((call) => {
			if (call === 2) controller.abort();
		});
		const { store, executor, built, permit } = await prepared(workspace, { fs });

		const failure = await executor
			.apply(built.changeset.id, { permitId: permit.id, signal: controller.signal })
			.catch((error: unknown) => error);

		expect((failure as ChangeControlError).code).toBe("CANCELLED");
		expect(snapshot(workspace)).toEqual(FILES);
		expect((store.readJournal(built.changeset.id) as Journal).state).toBe("rolled_back");
	});

	it("reports a commit that finished before the cancellation was seen as committed", async () => {
		const workspace = createTestWorkspace(FILES);
		const controller = new AbortController();
		const fs = faultyFs((call) => {
			if (call === 3) controller.abort();
		});
		const { executor, built, permit } = await prepared(workspace, { fs });

		const result = await executor.apply(built.changeset.id, { permitId: permit.id, signal: controller.signal });

		expect(result.committedAfterCancel).toBe(true);
		expect(snapshot(workspace)).toEqual(AFTER);
	});

	it("does not start when it is cancelled up front", async () => {
		const workspace = createTestWorkspace(FILES);
		const controller = new AbortController();
		controller.abort();
		const { store, executor, built, permit } = await prepared(workspace);

		expect(await codeOf(executor.apply(built.changeset.id, { permitId: permit.id, signal: controller.signal }))).toBe(
			"CANCELLED",
		);
		expect(store.permitUsed(permit.id)).toBe(false);
		expect(snapshot(workspace)).toEqual(FILES);
	});

	it("creates files, refuses to create over one that appeared, and removes a created file when rolling back", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "export const a = 1;\n" });
		const newPath = "src/new/created.ts";
		const plan = async () =>
			buildChangeset({
				workspaceRoot: workspace.root,
				description: "add a file",
				source: "patch",
				modified: [await modification(workspace, "src/a.ts", "export const a = 2;\n")],
				created: [
					{
						path: newPath,
						absolutePath: workspace.abs(newPath),
						key: await getMutationQueueKey(workspace.abs(newPath)),
						text: "export const created = true;\n",
					},
				],
			});

		// Someone created the file after the plan was made: the apply refuses and changes nothing.
		const first = createExecutor(workspace);
		const stale = await plan();
		await first.store.saveChangeset(stale);
		const stalePermit = await permitFor(first.store, stale);
		workspace.write(newPath, "someone got there first\n");
		expect(await codeOf(first.executor.apply(stale.changeset.id, { permitId: stalePermit.id }))).toBe(
			"EDIT_CONFLICT",
		);
		expect(workspace.readText("src/a.ts")).toBe("export const a = 1;\n");
		rmSync(workspace.abs("src/new"), { recursive: true, force: true });

		// A failure after the new file was written removes it again and restores the other file.
		const failing = createExecutor(workspace, {
			fs: faultyFs((call) => {
				if (call === 2) throw new Error("boom");
			}),
		});
		const rolledBack = await plan();
		await failing.store.saveChangeset(rolledBack);
		const rolledBackPermit = await permitFor(failing.store, rolledBack);
		await expect(failing.executor.apply(rolledBack.changeset.id, { permitId: rolledBackPermit.id })).rejects.toThrow(
			"boom",
		);
		expect(workspace.readText("src/a.ts")).toBe("export const a = 1;\n");
		expect(existsSync(workspace.abs(newPath))).toBe(false);

		// And when nothing goes wrong, the file is created together with the edit.
		const clean = createExecutor(workspace);
		const committed = await plan();
		await clean.store.saveChangeset(committed);
		const committedPermit = await permitFor(clean.store, committed);
		await clean.executor.apply(committed.changeset.id, { permitId: committedPermit.id });
		expect(workspace.readText(newPath)).toBe("export const created = true;\n");
		expect(workspace.readText("src/a.ts")).toBe("export const a = 2;\n");
	});

	it("reports a failing follow-up as an observer error without undoing the commit", async () => {
		const workspace = createTestWorkspace(FILES);
		const { executor, built, permit } = await prepared(workspace, {
			onCommitted: () => {
				throw new Error("index refresh failed");
			},
		});

		const result = await executor.apply(built.changeset.id, { permitId: permit.id });

		expect(result.status).toBe("committed");
		expect(result.observerError).toBe("index refresh failed");
		expect(snapshot(workspace)).toEqual(AFTER);
	});

	it("gives the same plan the same id and a different plan a different one", async () => {
		const workspace = createTestWorkspace(FILES);

		const first = await planOf(workspace, AFTER);
		const second = await planOf(workspace, AFTER);
		const changed = await planOf(workspace, { ...AFTER, "src/c.ts": "export const c = 31;\n" });

		expect(first.changeset.id).toBe(second.changeset.id);
		expect(changed.changeset.id).not.toBe(first.changeset.id);
		expect(readdirSync(workspace.root)).toEqual(["src"]);
	});

	it("serializes two applies over one file and lets the second see the first's result as a conflict", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store, executor } = createExecutor(workspace);
		const one = await planOf(workspace, { "src/a.ts": "export const a = 'one';\n" });
		const two = await planOf(workspace, { "src/a.ts": "export const a = 'two';\n" });
		await store.saveChangeset(one);
		await store.saveChangeset(two);
		const permitOne = await permitFor(store, one);
		const permitTwo = await permitFor(store, two);

		const results = await Promise.allSettled([
			executor.apply(one.changeset.id, { permitId: permitOne.id }),
			executor.apply(two.changeset.id, { permitId: permitTwo.id }),
		]);

		// Loading the journal/permit is asynchronous: either contender may acquire the lock first.
		// Exactly one must commit, and disk must match that winner; the loser must conflict.
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const winner = results.findIndex((result) => result.status === "fulfilled");
		expect(workspace.readText("src/a.ts")).toBe(`export const a = '${winner === 0 ? "one" : "two"}';\n`);
		const loser = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		expect((loser?.reason as ChangeControlError).code).toBe("EDIT_CONFLICT");
	});

	it("lets applies over different files run side by side", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store, executor } = createExecutor(workspace);
		const one = await planOf(workspace, { "src/a.ts": "export const a = 'one';\n" });
		const two = await planOf(workspace, { "src/b.ts": "export const b = 'two';\n" });
		await store.saveChangeset(one);
		await store.saveChangeset(two);
		const permitOne = await permitFor(store, one);
		const permitTwo = await permitFor(store, two);

		await Promise.all([
			executor.apply(one.changeset.id, { permitId: permitOne.id }),
			executor.apply(two.changeset.id, { permitId: permitTwo.id }),
		]);

		expect(workspace.readText("src/a.ts")).toBe("export const a = 'one';\n");
		expect(workspace.readText("src/b.ts")).toBe("export const b = 'two';\n");
	});
});
