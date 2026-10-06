import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChangeControl } from "../../../src/changes/factory.ts";
import type { CodeSymbol, CodeSymbolTreeNode } from "../../../src/symbols/types.ts";
import {
	createRefactorToolDefinition,
	RefactorToolError,
	type RefactorToolInput,
} from "../../../src/tools/refactor.ts";
import { createRealTsLab, type RealTsLab, realTypeScriptServerAvailable } from "./real-runtime.ts";

const available = realTypeScriptServerAvailable();
const TIMEOUT = 180_000;

let tscPath: string | undefined;
try {
	tscPath = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
} catch {
	tscPath = undefined;
}

/** The compiler's own verdict on the lab: an empty string, or what it reported. A second opinion beside the language server. */
function compile(root: string): string {
	if (!tscPath) throw new Error("the typescript package is needed for the compile check");
	try {
		execFileSync(process.execPath, [tscPath, "--noEmit", "-p", join(root, "tsconfig.json")], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		return "";
	} catch (error) {
		const failed = error as { stdout?: string; stderr?: string };
		return `${failed.stdout ?? ""}${failed.stderr ?? ""}` || String(error);
	}
}

const EXTRA_FILES: Readonly<Record<string, string>> = {
	// Uses of a function that are not calls: a value, a callback and a type query.
	"src/non-call.ts": [
		'import { formatArea } from "./util";',
		"",
		"export const formatter = formatArea;",
		"export const formatted = [1, 2].map(formatArea);",
		"export type Formatter = typeof formatArea;",
		"",
	].join("\n"),
	// An unrelated class that happens to be called like one in shapes.ts.
	"src/unrelated.ts": ["export class Circle {", "\tdiameter(): number {", "\t\treturn 2;", "\t}", "}", ""].join("\n"),
	"src/uses-unrelated.ts": [
		'import { Circle } from "./unrelated";',
		"",
		"export const diameter = new Circle().diameter();",
		"",
	].join("\n"),
};

function flatten(nodes: readonly CodeSymbolTreeNode[]): CodeSymbol[] {
	return nodes.flatMap((node) => [node.symbol, ...flatten(node.children)]);
}

function countOf(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

describe.skipIf(!available)("refactor against a real TypeScript language server", () => {
	let lab: RealTsLab;
	let agentDir: string;
	let tool: ReturnType<typeof createRefactorToolDefinition>;

	beforeEach(async () => {
		lab = await createRealTsLab(EXTRA_FILES);
		agentDir = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-real-refactor-agent-"));
		const changeControl = createChangeControl({ agentDir, workspaceRoot: lab.root, mode: () => "assist" });
		tool = createRefactorToolDefinition(lab.root, {
			codeIntelligence: lab.runtime.services,
			changeControl,
			sessionId: () => "real-session",
		});
		expect(compile(lab.root), "the sample project compiles before any change").toBe("");
	}, TIMEOUT);

	afterEach(async () => {
		await lab?.dispose();
		rmSync(agentDir, { recursive: true, force: true });
	}, TIMEOUT);

	async function run(input: RefactorToolInput) {
		const result = await tool.execute("real-call", input, undefined, undefined, undefined as never);
		const first = result.content[0];
		return { text: first?.type === "text" ? first.text : "", details: result.details };
	}

	const read = (path: string): string => readFileSync(join(lab.root, ...path.split("/")), "utf8");

	function idOf(text: string): string {
		const id = /changesetId: ([0-9a-f]{32})/u.exec(text)?.[1];
		if (!id) throw new Error(`no changesetId in: ${text}`);
		return id;
	}

	async function symbolsOf(path: string): Promise<CodeSymbol[]> {
		return flatten((await lab.runtime.router.fileSymbols(path, { timeoutMs: 60_000 })).items);
	}

	it(
		"renames a function with its re-export, its non-call uses and a type query, and keeps the alias other files use",
		async () => {
			const consumerBefore = read("src/consumer.ts");

			const preview = await run({
				operation: "preview_rename",
				target: { type: "position", path: "src/util.ts", position: { line: 0, character: 18 } },
				newName: "formatSurface",
				expectedName: "formatArea",
			});

			expect(preview.details?.files?.map((file) => file.path).sort()).toEqual([
				"src/index.ts",
				"src/non-call.ts",
				"src/util.ts",
			]);
			// Nothing is written by a preview.
			expect(read("src/util.ts")).toContain("export function formatArea");

			const applied = await run({ operation: "apply", changesetId: idOf(preview.text) });
			expect(applied.details).toMatchObject({ state: "committed", approval: "policy" });

			expect(read("src/util.ts")).toContain("export function formatSurface(value: number)");
			expect(read("src/index.ts")).toContain('export { formatSurface as fmt, pick } from "./util";');
			const nonCall = read("src/non-call.ts");
			expect(nonCall).toContain('import { formatSurface } from "./util";');
			expect(nonCall).toContain("export const formatter = formatSurface;");
			expect(nonCall).toContain("[1, 2].map(formatSurface)");
			expect(nonCall).toContain("typeof formatSurface");
			expect(nonCall).not.toContain("formatArea");
			// The module still exports the name `fmt`, so a file that only knows the alias is not touched.
			expect(read("src/consumer.ts")).toBe(consumerBefore);
			expect(compile(lab.root)).toBe("");
		},
		TIMEOUT,
	);

	it(
		"renames an interface method together with its implementations, overrides and calls",
		async () => {
			const preview = await run({
				operation: "preview_rename",
				target: { type: "position", path: "src/shapes.ts", position: { line: 1, character: 2 } },
				newName: "surface",
				expectedName: "area",
			});
			expect(preview.details?.files?.map((file) => file.path)).toEqual(["src/shapes.ts"]);

			await run({ operation: "apply", changesetId: idOf(preview.text) });

			const shapes = read("src/shapes.ts");
			// Shape.area, BaseShape.area, this.area() in describe, Circle.area, Square.area, shape.area() in totalArea.
			expect(countOf(shapes, /\barea\b/g)).toBe(0);
			expect(countOf(shapes, /\bsurface\b/g)).toBe(6);
			expect(compile(lab.root)).toBe("");
		},
		TIMEOUT,
	);

	it(
		"renames the class a symbol_id names and leaves an unrelated class with the same name alone",
		async () => {
			const circle = (await symbolsOf("src/shapes.ts")).find((symbol) => symbol.name === "Circle");
			expect(circle).toBeDefined();
			const unrelatedBefore = [read("src/unrelated.ts"), read("src/uses-unrelated.ts")];

			// The id names Circle: asking for another name is refused before anything is previewed.
			await expect(
				run({
					operation: "preview_rename",
					target: { type: "symbol_id", symbolId: (circle as CodeSymbol).id },
					newName: "Disc",
					expectedName: "Square",
				}),
			).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });

			const preview = await run({
				operation: "preview_rename",
				target: { type: "symbol_id", symbolId: (circle as CodeSymbol).id },
				newName: "Disc",
				expectedName: "Circle",
			});
			const files = preview.details?.files?.map((file) => file.path) ?? [];
			expect(files).toContain("src/shapes.ts");
			expect(files).toContain("src/consumer.ts");
			expect(files).not.toContain("src/unrelated.ts");
			expect(files).not.toContain("src/uses-unrelated.ts");

			await run({ operation: "apply", changesetId: idOf(preview.text) });

			expect(read("src/shapes.ts")).toContain("export class Disc extends BaseShape");
			expect(read("src/consumer.ts")).toContain("new Disc(radius)");
			expect([read("src/unrelated.ts"), read("src/uses-unrelated.ts")]).toEqual(unrelatedBefore);
			expect(compile(lab.root)).toBe("");
		},
		TIMEOUT,
	);

	it(
		"tells the caller which other files still say the old name, so a leftover is not silently lost",
		async () => {
			const preview = await run({
				operation: "preview_rename",
				target: { type: "position", path: "src/shapes.ts", position: { line: 15, character: 14 } },
				newName: "Disc",
				expectedName: "Circle",
			});

			// The unrelated class is not part of the rename, but its files mention the name: the caller is told.
			expect(preview.text).toMatch(/Not renamed: \d+ other file\(s\) still mention 'Circle'/u);
			expect(preview.text).toContain("src/unrelated.ts");
		},
		TIMEOUT,
	);

	it(
		"keeps text after a non-BMP character and the CRLF line endings of a file exactly",
		async () => {
			const emojiBefore = read("src/emoji.ts");
			const emojiColumn = (emojiBefore.split("\n")[1] ?? "").indexOf("Emoji");
			expect(emojiColumn).toBeGreaterThan(0);

			const emoji = await run({
				operation: "preview_rename",
				target: { type: "position", path: "src/emoji.ts", position: { line: 1, character: emojiColumn + 1 } },
				newName: "Smiley",
				expectedName: "Emoji",
			});
			await run({ operation: "apply", changesetId: idOf(emoji.text) });
			expect(read("src/emoji.ts")).toBe(emojiBefore.replace("export class Emoji", "export class Smiley"));

			const crlfBefore = read("src/crlf.ts");
			expect(crlfBefore).toContain("\r\n");
			const crlf = await run({
				operation: "preview_rename",
				target: { type: "position", path: "src/crlf.ts", position: { line: 0, character: 15 } },
				newName: "Panes",
				expectedName: "Windows",
			});
			await run({ operation: "apply", changesetId: idOf(crlf.text) });
			expect(read("src/crlf.ts")).toBe(crlfBefore.replace("class Windows", "class Panes"));
			expect(compile(lab.root)).toBe("");
		},
		TIMEOUT,
	);

	it(
		"never renames the keyword a position is on, and refuses a new name that is not one token, writing nothing",
		async () => {
			const utilBefore = read("src/util.ts");

			// The server answers a position on `export` with the declaration it belongs to: the name that is
			// actually renamed is reported, so a caller who meant the keyword is refused by expectedName.
			const keyword = await run({
				operation: "preview_rename",
				target: { type: "position", path: "src/util.ts", position: { line: 0, character: 2 } },
				newName: "renamed",
				expectedName: "export",
			}).catch((error: unknown) => error);
			expect(keyword).toBeInstanceOf(RefactorToolError);
			expect((keyword as RefactorToolError).code).toBe("TARGET_AMBIGUOUS");
			expect((keyword as RefactorToolError).message).toContain("formatArea");

			const invalidName = await run({
				operation: "preview_rename",
				target: { type: "position", path: "src/util.ts", position: { line: 0, character: 18 } },
				newName: "not an identifier",
			}).catch((error: unknown) => error);
			expect(invalidName).toBeInstanceOf(RefactorToolError);
			expect((invalidName as RefactorToolError).code).toBe("RENAME_REFUSED");
			expect((invalidName as RefactorToolError).message).toContain("whitespace");

			expect(read("src/util.ts")).toBe(utilBefore);
		},
		TIMEOUT,
	);
});
