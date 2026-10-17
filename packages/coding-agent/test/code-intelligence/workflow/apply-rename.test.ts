import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceIdentity, normalizeWorkspaceRoot } from "../../../src/symbols/path-semantics.ts";
import {
	clearRenamePlans,
	getRenamePlan,
	getRenamePlanPaths,
	type RenamePlan,
	type RenamePlanFile,
	storeRenamePlan,
} from "../../../src/symbols/workflow/rename-plans.ts";
import { sha256Hex } from "../../../src/symbols/workflow/text.ts";
import { createApplyRenameToolDefinition } from "../../../src/tools/apply-rename.ts";
import { replaceFileStep, runWriteSteps } from "../../../src/tools/files/apply-patch.ts";

const roots: string[] = [];

afterEach(async () => {
	clearRenamePlans();
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

async function workspace(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "myharness-apply-rename-"));
	roots.push(root);
	for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text, "utf8");
	return root;
}

async function planFile(root: string, path: string, oldName: string, newName: string): Promise<RenamePlanFile> {
	const absolutePath = join(root, path);
	const bytes = await readFile(absolutePath);
	const raw = bytes.toString("utf8");
	const bom = raw.startsWith("﻿");
	const originalText = bom ? raw.slice(1) : raw;
	return {
		path,
		absolutePath,
		sha256: sha256Hex(bytes),
		bom,
		originalText,
		newText: originalText.split(oldName).join(newName),
		edits: [{ line: 0, oldText: oldName, newText: newName }],
	};
}

let planCounter = 0;

function makePlan(root: string, files: RenamePlanFile[], overrides: Partial<RenamePlan> = {}): RenamePlan {
	const now = Date.now();
	const plan: RenamePlan = {
		id: `rn_test${++planCounter}`,
		workspaceRoot: root,
		workspaceIdentity: getWorkspaceIdentity(normalizeWorkspaceRoot(root)),
		createdAt: now,
		expiresAt: now + 60_000,
		oldName: "oldName",
		newName: "newName",
		target: "function oldName (a.ts:1)",
		files,
		...overrides,
	};
	storeRenamePlan(plan);
	return plan;
}

async function apply(root: string, planId: string, signal?: AbortSignal) {
	const tool = createApplyRenameToolDefinition(root);
	return tool.execute("call", { planId }, signal, undefined, undefined as never);
}

describe("apply_rename", () => {
	it("writes every file of the plan, keeps a BOM, and can be used only once", async () => {
		const root = await workspace({
			"a.ts": "export function oldName() {}\n",
			"b.ts": "﻿import { oldName } from './a';\noldName();\n",
		});
		const plan = makePlan(root, [
			await planFile(root, "a.ts", "oldName", "newName"),
			await planFile(root, "b.ts", "oldName", "newName"),
		]);

		const result = await apply(root, plan.id);

		expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export function newName() {}\n");
		expect(await readFile(join(root, "b.ts"), "utf8")).toBe("﻿import { newName } from './a';\nnewName();\n");
		expect(result.details?.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
		expect(getRenamePlan(plan.id)).toBeUndefined();
		// Change tracking can still name the files after the plan is consumed.
		expect(getRenamePlanPaths(plan.id)).toHaveLength(2);
		await expect(apply(root, plan.id)).rejects.toThrow(/no rename plan/);
	});

	it("refuses the whole plan when any file changed after the preview, writing nothing", async () => {
		const root = await workspace({ "a.ts": "export function oldName() {}\n", "b.ts": "oldName();\n" });
		const plan = makePlan(root, [
			await planFile(root, "a.ts", "oldName", "newName"),
			await planFile(root, "b.ts", "oldName", "newName"),
		]);
		await writeFile(join(root, "b.ts"), "oldName(); // edited elsewhere\n", "utf8");

		await expect(apply(root, plan.id)).rejects.toThrow(
			/b\.ts \(content differs from the preview\)[\s\S]*nothing was written|nothing was written/,
		);
		expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export function oldName() {}\n");
		expect(await readFile(join(root, "b.ts"), "utf8")).toBe("oldName(); // edited elsewhere\n");
		// A refused plan is not consumed: the agent re-previews, it cannot be half applied.
		expect(getRenamePlan(plan.id)).toBeDefined();
	});

	it("refuses a plan whose file was deleted after the preview", async () => {
		const root = await workspace({ "a.ts": "export function oldName() {}\n", "b.ts": "oldName();\n" });
		const plan = makePlan(root, [
			await planFile(root, "a.ts", "oldName", "newName"),
			await planFile(root, "b.ts", "oldName", "newName"),
		]);
		await rm(join(root, "b.ts"));

		await expect(apply(root, plan.id)).rejects.toThrow(/cannot be read/);
		expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export function oldName() {}\n");
	});

	it("refuses a plan made for another workspace", async () => {
		const root = await workspace({ "a.ts": "export function oldName() {}\n" });
		const other = await workspace({});
		const plan = makePlan(root, [await planFile(root, "a.ts", "oldName", "newName")]);

		await expect(apply(other, plan.id)).rejects.toThrow(/was made for workspace/);
		expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export function oldName() {}\n");
	});

	it("refuses an expired plan", async () => {
		const root = await workspace({ "a.ts": "export function oldName() {}\n" });
		const plan = makePlan(root, [await planFile(root, "a.ts", "oldName", "newName")], {
			expiresAt: Date.now() - 1,
		});
		await expect(apply(root, plan.id)).rejects.toThrow(/no rename plan/);
	});

	it("restores the files already written when a later write fails (shared apply_patch write steps)", async () => {
		const root = await workspace({ "a.ts": "export function oldName() {}\n" });
		const before = await readFile(join(root, "a.ts"));
		await expect(
			runWriteSteps(
				[
					replaceFileStep("a.ts", join(root, "a.ts"), "export function newName() {}\n", before),
					{
						description: "write b.ts",
						run: async () => {
							throw new Error("disk full");
						},
						undo: async () => {},
					},
				],
				"apply_rename",
			),
		).rejects.toThrow(/apply_rename[\s\S]*a\.ts/);
		expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export function oldName() {}\n");
	});

	it("writes nothing when cancelled before the write", async () => {
		const root = await workspace({ "a.ts": "export function oldName() {}\n" });
		const plan = makePlan(root, [await planFile(root, "a.ts", "oldName", "newName")]);
		const controller = new AbortController();
		controller.abort();

		await expect(apply(root, plan.id, controller.signal)).rejects.toThrow();
		expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export function oldName() {}\n");
	});
});
