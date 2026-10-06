import { afterEach, describe, expect, it } from "vitest";
import type { CodeSymbol, CodeSymbolTreeNode } from "../../../src/symbols/types.ts";
import {
	createMockEnvironment,
	FULL_CAPABILITIES,
	type MockEnvironment,
	range,
} from "../helpers/configurable-server.ts";

const environments: MockEnvironment[] = [];

afterEach(async () => {
	for (const environment of environments.splice(0)) await environment.dispose();
});

function setup(documentSymbols: Record<string, unknown>, files: Record<string, string>): MockEnvironment {
	const environment = createMockEnvironment([
		{ id: "mock-ts", languages: ["typescript"], config: { capabilities: FULL_CAPABILITIES, documentSymbols } },
	]);
	environments.push(environment);
	for (const [path, content] of Object.entries(files)) environment.write(path, content);
	return environment;
}

const options = (root: string) => ({ workspaceRoot: root, language: "typescript", timeoutMs: 10_000 });

function flatten(nodes: readonly CodeSymbolTreeNode[]): CodeSymbol[] {
	return nodes.flatMap((node) => [node.symbol, ...flatten(node.children)]);
}

describe("document symbol name ranges", () => {
	it("tells overloads apart when the server reports the first overload's name for all of them", async () => {
		const text = [
			"export function pick(value: string): string;",
			"export function pick(value: number): number;",
			"export function pick(value: string | number): string | number {",
			"\treturn value;",
			"}",
			"",
		].join("\n");
		const wrong = range(0, 16, 0, 20);
		const environment = setup(
			{
				"src/util.ts": [
					{ name: "pick", kind: 12, range: range(0, 0, 0, 44), selectionRange: wrong },
					{ name: "pick", kind: 12, range: range(1, 0, 1, 44), selectionRange: wrong },
					{ name: "pick", kind: 12, range: range(2, 0, 4, 1), selectionRange: wrong },
				],
			},
			{ "src/util.ts": text },
		);

		const result = await environment.backend.fileSymbols("src/util.ts", options(environment.root));
		const picks = flatten(result.items);

		expect(picks.map((symbol) => symbol.selectionRange?.start)).toEqual([
			{ line: 0, character: 16 },
			{ line: 1, character: 16 },
			{ line: 2, character: 16 },
		]);
		expect(new Set(picks.map((symbol) => symbol.id)).size).toBe(3);
		expect(result.meta.completeness).toBe("complete");
	});

	it("replaces a selectionRange that covers the whole declaration with the name token", async () => {
		const text = "export class Foo {\n\tbar(): void {}\n}\n";
		const environment = setup(
			{
				"src/foo.ts": [
					{
						name: "Foo",
						kind: 5,
						range: range(0, 0, 2, 1),
						selectionRange: range(0, 0, 2, 1),
						children: [{ name: "bar", kind: 6, range: range(1, 1, 1, 14), selectionRange: range(1, 1, 1, 14) }],
					},
				],
			},
			{ "src/foo.ts": text },
		);

		const result = await environment.backend.fileSymbols("src/foo.ts", options(environment.root));
		const [foo, bar] = flatten(result.items);

		expect(foo.selectionRange).toEqual(range(0, 13, 0, 16));
		expect(bar.selectionRange).toEqual(range(1, 1, 1, 4));
		expect(bar.parentId).toBe(foo.id);
		expect(bar.namePath).toBe("Foo/bar");
	});

	it("keeps a correct server selectionRange unchanged and tags every symbol with its server", async () => {
		const text = "export class Foo {\n\tbar(): void {}\n}\n";
		const environment = setup(
			{
				"src/foo.ts": [
					{
						name: "Foo",
						kind: 5,
						range: range(0, 0, 2, 1),
						selectionRange: range(0, 13, 0, 16),
						children: [{ name: "bar", kind: 6, range: range(1, 1, 1, 14), selectionRange: range(1, 1, 1, 4) }],
					},
				],
			},
			{ "src/foo.ts": text },
		);

		const result = await environment.backend.fileSymbols("src/foo.ts", options(environment.root));

		expect(flatten(result.items).map((symbol) => symbol.selectionRange)).toEqual([
			range(0, 13, 0, 16),
			range(1, 1, 1, 4),
		]);
		for (const symbol of flatten(result.items)) {
			expect(symbol.provenance).toEqual({ definitionId: "mock-ts", projectRoot: expect.any(String) });
		}
		expect(result.meta).toEqual({ source: "semantic", completeness: "complete" });
	});

	it("does not invent a name range for synthetic names that have no token in the source", async () => {
		const text = "export function total(shapes: number[]) {\n\treturn shapes.reduce((a, b) => a + b, 0);\n}\n";
		const environment = setup(
			{
				"src/total.ts": [
					{
						name: "total",
						kind: 12,
						range: range(0, 0, 2, 1),
						selectionRange: range(0, 16, 0, 21),
						children: [
							{
								name: "shapes.reduce() callback",
								kind: 12,
								range: range(1, 24, 1, 39),
								selectionRange: range(1, 24, 1, 39),
							},
						],
					},
				],
			},
			{ "src/total.ts": text },
		);

		const result = await environment.backend.fileSymbols("src/total.ts", options(environment.root));
		const callback = flatten(result.items)[1];

		expect(callback.selectionRange).toBeUndefined();
		expect(callback.bodyRange).toEqual(range(1, 24, 1, 39));
		expect(result.meta.completeness).toBe("complete");
	});

	it("counts UTF-16 units when the declaration follows non-BMP text on the same line", async () => {
		const text = "const note = '😀'; export class Emoji {}\n";
		const nameStart = text.indexOf("Emoji");
		const environment = setup(
			{
				"src/emoji.ts": [
					{
						name: "Emoji",
						kind: 5,
						range: range(0, text.indexOf("export"), 0, text.length - 1),
						selectionRange: range(0, text.indexOf("export"), 0, text.length - 1),
					},
				],
			},
			{ "src/emoji.ts": text },
		);

		const result = await environment.backend.fileSymbols("src/emoji.ts", options(environment.root));

		expect(flatten(result.items)[0].selectionRange).toEqual(range(0, nameStart, 0, nameStart + "Emoji".length));
	});
});

describe("flat SymbolInformation results", () => {
	it("is rebuilt into a tree from declaration containment with located name ranges", async () => {
		const text = "export class Foo {\n\tbar(): void {}\n}\nexport function helper() {}\n";
		const at = (startLine: number, startCharacter: number, endLine: number, endCharacter: number) => ({
			path: "src/foo.ts",
			range: range(startLine, startCharacter, endLine, endCharacter),
		});
		const environment = setup(
			{
				"src/foo.ts": [
					{ name: "helper", kind: 12, location: at(3, 0, 3, 27) },
					{ name: "bar", kind: 6, containerName: "Foo", location: at(1, 1, 1, 14) },
					{ name: "Foo", kind: 5, location: at(0, 0, 2, 1) },
				],
			},
			{ "src/foo.ts": text },
		);

		const result = await environment.backend.fileSymbols("src/foo.ts", options(environment.root));

		expect(result.items.map((node) => node.symbol.namePath)).toEqual(["Foo", "helper"]);
		const foo = result.items[0];
		expect(foo.children.map((node) => node.symbol.namePath)).toEqual(["Foo/bar"]);
		expect(foo.children[0].symbol.parentId).toBe(foo.symbol.id);
		expect(foo.symbol.selectionRange).toEqual(range(0, 13, 0, 16));
		expect(foo.children[0].symbol.selectionRange).toEqual(range(1, 1, 1, 4));
		expect(foo.symbol.declarationRange).toEqual(range(0, 0, 2, 1));
		expect(result.items[1].symbol.selectionRange).toEqual(range(3, 16, 3, 22));
		expect(foo.symbol.provenance?.definitionId).toBe("mock-ts");
	});

	it("keeps SymbolInformation whose range is already the name", async () => {
		const text = "export class Foo {}\n";
		const environment = setup(
			{
				"src/foo.ts": [{ name: "Foo", kind: 5, location: { path: "src/foo.ts", range: range(0, 13, 0, 16) } }],
			},
			{ "src/foo.ts": text },
		);

		const result = await environment.backend.fileSymbols("src/foo.ts", options(environment.root));

		expect(result.items[0].symbol.selectionRange).toEqual(range(0, 13, 0, 16));
		expect(result.meta.completeness).toBe("complete");
	});
});
