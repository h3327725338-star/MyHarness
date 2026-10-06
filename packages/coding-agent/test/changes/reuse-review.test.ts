import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChangeControl } from "../../src/changes/factory.ts";
import { CodeSymbolIndex } from "../../src/symbols/index/code-index.ts";
import { StructuralReuseGate } from "../../src/symbols/index/reuse-review.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const body = `let total = 0; for (const value of values) { if (value > 0) { total += value * 2; } else { total -= value; } } return total;`;
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "reuse-gate-"));
	roots.push(root);
	await writeFile(join(root, "existing.ts"), `export function sum(values: number[]) { ${body} }`);
	const index = new CodeSymbolIndex({ cwd: root, agentDir: join(root, "agent") });
	const gate = new StructuralReuseGate(index, root, [resolve("../..")]);
	const control = createChangeControl({ workspaceRoot: root, agentDir: join(root, "agent"), gates: [gate] });
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
