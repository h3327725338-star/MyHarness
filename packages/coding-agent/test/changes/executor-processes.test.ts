import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import type { Journal } from "../../src/changes/change-store.ts";
import { acquireProcessLocks } from "../../src/changes/process-lock.ts";
import { createExecutor, createTestWorkspace, disposeTestWorkspaces, permitFor, planOf } from "./helpers.ts";

afterEach(disposeTestWorkspaces);

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const LOADER = pathToFileURL(join(REPOSITORY_ROOT, "scripts", "dev-fast-loader.mjs")).href;
const CHILD = fileURLToPath(new URL("./fixtures/apply-child.ts", import.meta.url));

interface ChildOutcome {
	ok: boolean;
	code?: string;
	message?: string;
	files?: string[];
}

function runChild(args: string[]): Promise<ChildOutcome> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", LOADER, CHILD, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let errors = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			errors += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const line = output.trim().split("\n").pop() ?? "";
			try {
				resolvePromise(JSON.parse(line) as ChildOutcome);
			} catch {
				reject(new Error(`child exited with ${code}: ${errors || output}`));
			}
		});
	});
}

const FILES = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };

describe("process locks", () => {
	it("stop waiting when cancelled and release the locks they already took", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store } = createExecutor(workspace);
		const busy = await acquireProcessLocks(["b-key"], { lockRoot: store.lockRoot });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);

		const started = Date.now();
		const attempt = acquireProcessLocks(["a-key", "b-key"], {
			lockRoot: store.lockRoot,
			timeoutMs: 20_000,
			signal: controller.signal,
		});

		await expect(attempt).rejects.toMatchObject({ code: "CANCELLED" });
		expect(Date.now() - started).toBeLessThan(5_000);
		await busy.release();
		// "a-key" was taken first and must have been given back.
		const again = await acquireProcessLocks(["a-key", "b-key"], { lockRoot: store.lockRoot, timeoutMs: 1_000 });
		await again.release();
		expect(readdirSync(store.lockRoot).filter((name) => name.endsWith(".lock"))).toEqual([]);
	}, 30_000);
});

describe("changes across processes", () => {
	it("lets exactly one of two processes change the same files and never mixes their results", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store } = createExecutor(workspace);
		const one = await planOf(workspace, {
			"src/a.ts": "export const a = 'one';\n",
			"src/b.ts": "export const b = 'one';\n",
		});
		const two = await planOf(workspace, {
			"src/a.ts": "export const a = 'two';\n",
			"src/b.ts": "export const b = 'two';\n",
		});
		await store.saveChangeset(one);
		await store.saveChangeset(two);
		const permitOne = await permitFor(store, one);
		const permitTwo = await permitFor(store, two);

		const outcomes = await Promise.all([
			runChild([workspace.root, workspace.storeRoot, one.changeset.id, permitOne.id, "400", "20000"]),
			runChild([workspace.root, workspace.storeRoot, two.changeset.id, permitTwo.id, "400", "20000"]),
		]);

		expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
		const loser = outcomes.find((outcome) => !outcome.ok);
		expect(loser?.code).toBe("EDIT_CONFLICT");
		const winner = outcomes[0].ok ? "one" : "two";
		expect(workspace.readText("src/a.ts")).toBe(`export const a = '${winner}';\n`);
		expect(workspace.readText("src/b.ts")).toBe(`export const b = '${winner}';\n`);
		const winningId = winner === "one" ? one.changeset.id : two.changeset.id;
		expect((store.readJournal(winningId) as Journal).state).toBe("committed");
		expect(readdirSync(store.lockRoot).filter((name) => name.endsWith(".lock"))).toEqual([]);
	}, 60_000);

	it("keeps a second process waiting and then gives up with a clear error, changing nothing", async () => {
		const workspace = createTestWorkspace(FILES);
		const { store } = createExecutor(workspace);
		const plan = await planOf(workspace, { "src/a.ts": "export const a = 'x';\n" });
		await store.saveChangeset(plan);
		const permit = await permitFor(store, plan);
		const key = plan.changeset.files[0].key;

		const held = await acquireProcessLocks([key], { lockRoot: store.lockRoot });
		let outcome: ChildOutcome;
		try {
			outcome = await runChild([workspace.root, workspace.storeRoot, plan.changeset.id, permit.id, "0", "600"]);
		} finally {
			await held.release();
		}

		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe("LOCK_TIMEOUT");
		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
		expect(store.permitUsed(permit.id)).toBe(false);
		expect(existsSync(join(store.root, "journals", `${plan.changeset.id}.json`))).toBe(false);
	}, 60_000);
});
