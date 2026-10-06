import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalPort } from "../../src/changes/approval.ts";
import { createChangeControl } from "../../src/changes/factory.ts";
import type { ChangeGate } from "../../src/changes/service.ts";
import { CodeSymbolIndex } from "../../src/symbols/index/code-index.ts";
import { StructuralReuseGate } from "../../src/symbols/index/reuse-review.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const body = `let total = 0; for (const value of values) { if (value > 0) { total += value * 2; } else { total -= value; } } return total;`;
async function setup(approval?: ApprovalPort, extraGate?: ChangeGate, now?: () => number) {
	const root = await mkdtemp(join(tmpdir(), "reuse-gate-"));
	roots.push(root);
	await writeFile(join(root, "existing.ts"), `export function sum(values: number[]) { ${body} }`);
	const index = new CodeSymbolIndex({ cwd: root, agentDir: join(root, "agent") });
	const gate = new StructuralReuseGate(index, root, [resolve("../..")]);
	const control = createChangeControl({
		workspaceRoot: root,
		agentDir: join(root, "agent"),
		gates: [gate, ...(extraGate ? [extraGate] : [])],
		approval,
		now,
	});
	return { root, control };
}
describe("actual-diff structural reuse review", () => {
	it("blocks renamed cross-file clones on direct full-file write", async () => {
		const { root, control } = await setup();
		const preview = await control.previewWrite(
			"copy.ts",
			`export function renamed(items: number[]) { ${body.replaceAll("values", "items").replaceAll("total", "result")} }`,
		);
		await expect(control.apply(preview.changeset.id, { origin: { kind: "write" } })).rejects.toMatchObject({
			code: "REUSE_REVIEW_REQUIRED",
		});
		await expect(readFile(join(root, "copy.ts"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("detects copied logic pasted inside an existing function", async () => {
		const { root, control } = await setup();
		await writeFile(join(root, "other.ts"), "export function other(values: number[]) { return values.length; }");
		const preview = await control.previewWrite(
			"other.ts",
			`export function other(values: number[]) { console.log('different wrapper'); ${body} }`,
		);
		await expect(control.apply(preview.changeset.id, { origin: { kind: "edit" } })).rejects.toMatchObject({
			code: "REUSE_REVIEW_REQUIRED",
		});
	});
	it("detects near-miss clones that retain a sufficiently large shared block", async () => {
		const { control } = await setup();
		const preview = await control.previewWrite(
			"near.ts",
			`export function near(values: number[]) { ${body.replace("return total;", "return total + 1;")} }`,
		);
		await expect(control.apply(preview.changeset.id, { origin: { kind: "write" } })).rejects.toMatchObject({
			code: "REUSE_REVIEW_REQUIRED",
		});
	});

	it("blocks newly copied functions within the same file", async () => {
		const { control } = await setup();
		const preview = await control.previewWrite(
			"existing.ts",
			`export function sum(values: number[]) { ${body} }\nexport function copy(values: number[]) { ${body} }`,
		);
		await expect(control.apply(preview.changeset.id, { origin: { kind: "write" } })).rejects.toMatchObject({
			code: "REUSE_REVIEW_REQUIRED",
		});
	});

	it("blocks duplicate blocks introduced together in new files", async () => {
		const { root, control } = await setup();
		await rm(join(root, "existing.ts"));
		const preview = await control.previewPatch(
			[
				{ path: "one.ts", content: `export function one(values: number[]) { ${body} }` },
				{ path: "two.ts", content: `export function two(values: number[]) { ${body} }` },
			],
			{ description: "two new implementations" },
		);
		await expect(control.apply(preview.changeset.id, { origin: { kind: "refactor" } })).rejects.toMatchObject({
			code: "REUSE_REVIEW_REQUIRED",
		});
	});

	it("strict rejects review when the runtime compiler is unavailable", async () => {
		const { root } = await setup();
		const index = new CodeSymbolIndex({ cwd: root, agentDir: join(root, "index") });
		const control = createChangeControl({
			workspaceRoot: root,
			agentDir: join(root, "strict"),
			mode: () => "strict",
			gates: [new StructuralReuseGate(index, root)],
		});
		const preview = await control.previewWrite("new.ts", "export const value = 1;");
		await expect(control.apply(preview.changeset.id, { origin: { kind: "write" } })).rejects.toMatchObject({
			code: "REUSE_REVIEW_REQUIRED",
		});
	});

	it.each(["accept", "decline", "changed", "cancel", "new-file", "config", "expired", "after-gate"] as const)(
		"binds explicit reuse exception: %s",
		async (action) => {
			let labRoot = "";
			let clock = 1000;
			const abort = new AbortController();
			const { root, control } = await setup(
				{
					request: async (request) => {
						expect(request.title).toBe("Review reuse exception");
						expect(request.message).toContain("Snapshot:");
						if (action === "accept") expect(request.message).toContain("second.ts");
						if (action === "changed")
							await writeFile(
								join(labRoot, "existing.ts"),
								`// changed\nexport function sum(values: number[]) { ${body} }`,
							);
						if (action === "new-file") await writeFile(join(labRoot, "new.ts"), "export const added = 1;");
						if (action === "config")
							await writeFile(join(labRoot, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
						if (action === "expired") clock += 300001;
						if (action === "cancel") abort.abort();
						return action === "decline" ? { approved: false, reason: "reuse required" } : { approved: true };
					},
				},
				{
					name: "subsequent-gate",
					check: async () => {
						if (action === "after-gate")
							await writeFile(
								join(labRoot, "existing.ts"),
								`// later gate\nexport function sum(values: number[]) { ${body} }`,
							);
						return { allow: true };
					},
				},
				() => clock,
			);
			labRoot = root;
			if (action === "accept")
				await writeFile(join(root, "second.ts"), `export function sumAgain(values: number[]) { ${body} }`);
			const preview = await control.previewWrite("copy.ts", `export function copy(values: number[]) { ${body} }`);
			const applying = control.apply(preview.changeset.id, { origin: { kind: "write" }, signal: abort.signal });
			if (action === "accept") {
				const outcome = await applying;
				expect(outcome.result.status).toBe("committed");
				expect(outcome.approvedBy).toBe("user");
			} else {
				await expect(applying).rejects.toBeDefined();
				await expect(readFile(join(root, "copy.ts"))).rejects.toMatchObject({ code: "ENOENT" });
			}
		},
	);

	it("does not call different literals/operators equivalent", async () => {
		const { control } = await setup();
		const preview = await control.previewWrite(
			"different.ts",
			`export function other(values: number[]) { ${body.replaceAll("0", "10").replaceAll("2", "5").replaceAll("+=", "*=").replaceAll("-=", "/=")} }`,
		);
		const outcome = await control.apply(preview.changeset.id, { origin: { kind: "write" } });
		expect(outcome.result.status).toBe("committed");
	});
});
