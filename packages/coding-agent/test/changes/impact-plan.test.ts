import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeStore } from "../../src/changes/change-store.ts";
import type { ImpactPlan } from "../../src/changes/impact-plan.ts";
import { ChangeControl } from "../../src/changes/service.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "./helpers.ts";

afterEach(disposeTestWorkspaces);
describe("preview-bound impact review", () => {
	it("requires strict review, rejects omitted paths and partial coverage, and preserves it across restart", async () => {
		const workspace = createTestWorkspace({ "a.py": "value = 1\n", "caller.py": "from a import value\n" });
		const store = new ChangeStore(workspace.storeRoot);
		const control = new ChangeControl({ workspaceRoot: workspace.root, store, mode: () => "strict" });
		const preview = await control.previewPatch(
			[{ path: "a.py", edits: [{ oldText: "value = 1", newText: "value = 2" }] }],
			{ description: "correct value" },
		);
		const apply = () => control.apply(preview.changeset.id, { origin: { kind: "refactor" } });
		await expect(apply()).rejects.toMatchObject({ code: "PERMIT_REQUIRED" });
		const plan: ImpactPlan = {
			problem: "wrong value",
			expectedBehavior: "value is two",
			rootCause: "initializer",
			rootPaths: ["a.py"],
			evidence: ["read a.py"],
			affected: [{ path: "a.py", disposition: "modify", reason: "root initializer" }],
			compatibility: "no public API change",
			checks: ["isolated behavior test"],
			coverage: "partial",
			limitations: ["external consumers not checked"],
		};
		await expect(
			control.reviewImpact(preview.changeset.id, {
				...plan,
				affected: [{ path: "b.py", disposition: "modify", reason: "incorrect scope" }],
			}),
		).rejects.toMatchObject({ code: "PERMIT_REQUIRED" });
		await control.reviewImpact(preview.changeset.id, plan);
		await expect(apply()).rejects.toMatchObject({ code: "PERMIT_REQUIRED" });
		await control.reviewImpact(preview.changeset.id, { ...plan, coverage: "complete", limitations: [] });
		const restored = new ChangeControl({ workspaceRoot: workspace.root, store, mode: () => "strict" });
		expect((await restored.impactPlans.load(preview.changeset.id))?.rootCause).toBe("initializer");
		const withCaller: ImpactPlan = {
			...plan,
			coverage: "complete",
			limitations: [],
			affected: [...plan.affected, { path: "caller.py", disposition: "unaffected", reason: "export is unchanged" }],
		};
		await control.reviewImpact(preview.changeset.id, withCaller);
		await writeFile(join(workspace.root, "caller.py"), "from a import removed\n");
		await expect(apply()).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
		expect(workspace.readText("a.py")).toBe("value = 1\n");
		await expect(
			control.reviewImpact(preview.changeset.id, { ...withCaller, rootPaths: ["missing.py"] }),
		).rejects.toMatchObject({ code: "PERMIT_REQUIRED" });
		await control.reviewImpact(preview.changeset.id, withCaller);
		const interleaved = new ChangeControl({
			workspaceRoot: workspace.root,
			store,
			mode: () => "strict",
			gates: [
				{
					name: "review-changes-during-query",
					check: async () => {
						await control.reviewImpact(preview.changeset.id, {
							...withCaller,
							rootCause: "changed after graph query",
						});
						return { allow: true };
					},
				},
			],
		});
		await expect(interleaved.apply(preview.changeset.id, { origin: { kind: "refactor" } })).rejects.toMatchObject({
			code: "EDIT_CONFLICT",
		});
		expect(workspace.readText("a.py")).toBe("value = 1\n");
		await control.reviewImpact(preview.changeset.id, withCaller);
		await expect(apply()).resolves.toMatchObject({ approvedBy: "policy" });
	});
});
