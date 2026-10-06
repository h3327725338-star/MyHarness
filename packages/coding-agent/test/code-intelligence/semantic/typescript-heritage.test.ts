import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	analyzeHeritage,
	clearTypeScriptProgramCache,
	type HeritageResult,
} from "../../../src/symbols/semantic/typescript-heritage.ts";

/** The repository's own node_modules holds the compiler the tests use as the "managed runtime". */
const RUNTIME_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

const TSCONFIG = JSON.stringify({
	compilerOptions: {
		strict: true,
		module: "ESNext",
		moduleResolution: "Bundler",
		target: "ES2022",
		noEmit: true,
		skipLibCheck: true,
	},
	include: ["src"],
});

const FILES: Record<string, string> = {
	"tsconfig.json": TSCONFIG,
	"src/base.ts": [
		"export interface Shape {",
		"\tarea(): number;",
		"}",
		"export abstract class BaseShape implements Shape {",
		"\tabstract area(): number;",
		"}",
		"",
	].join("\n"),
	"src/circle.ts": [
		'import { BaseShape as B } from "./base";',
		"export class Circle extends B {",
		"\tarea(): number {",
		"\t\treturn 1;",
		"\t}",
		"}",
		"",
	].join("\n"),
	"src/reexport.ts": 'export { BaseShape as Renamed } from "./base";\n',
	"src/square.ts": [
		'import { Renamed } from "./reexport";',
		"export class Square extends Renamed {",
		"\tarea(): number {",
		"\t\treturn 2;",
		"\t}",
		"}",
		"",
	].join("\n"),
	"src/ns.ts": [
		'import * as base from "./base";',
		"export class Triangle extends base.BaseShape {",
		"\tarea(): number {",
		"\t\treturn 3;",
		"\t}",
		"}",
		"",
	].join("\n"),
	// Same members as Shape, but nothing says it is a Shape: structural compatibility is not inheritance.
	"src/duck.ts": ["export class Duck {", "\tarea(): number {", "\t\treturn 4;", "\t}", "}", ""].join("\n"),
	"src/cycle.ts": ["export interface A extends B {}", "export interface B extends A {}", ""].join("\n"),
	"src/mixin.ts": [
		"function mixin<T extends new (...args: any[]) => object>(Base: T) {",
		"\treturn class extends Base {};",
		"}",
		"export class Mixed extends mixin(Object) {}",
		"",
	].join("\n"),
	"packages/b/tsconfig.json": JSON.stringify({
		compilerOptions: {
			strict: true,
			module: "ESNext",
			moduleResolution: "Bundler",
			target: "ES2022",
			noEmit: true,
			skipLibCheck: true,
		},
		include: ["src"],
	}),
	"packages/b/src/child.ts": [
		'import { BaseShape } from "../../../src/base";',
		"export class Child extends BaseShape {",
		"\tarea(): number {",
		"\t\treturn 5;",
		"\t}",
		"}",
		"",
	].join("\n"),
};

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-heritage-"));
	for (const [path, content] of Object.entries(FILES)) {
		const target = join(root, ...path.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
});

afterAll(() => {
	clearTypeScriptProgramCache();
	rmSync(root, { recursive: true, force: true });
});

function ask(
	direction: "supertypes" | "subtypes",
	path: string,
	line: number,
	character: number,
	extra: Partial<Parameters<typeof analyzeHeritage>[0]> = {},
): HeritageResult {
	return analyzeHeritage({
		workspaceRoot: root,
		path,
		position: { line, character },
		direction,
		runtimeRoots: [RUNTIME_ROOT],
		...extra,
	});
}

function names(result: HeritageResult): string[] {
	if (result.status !== "ok") throw new Error(`unexpected status ${result.status}`);
	return result.items.map((item) => `${item.name}:${item.relation}@${item.path}`);
}

describe("TypeScript heritage adapter", () => {
	it("finds the extends target of a class declared through an import alias", () => {
		const result = ask("supertypes", "src/circle.ts", 1, 14);

		expect(names(result)).toEqual(["BaseShape:extends@src/base.ts"]);
		if (result.status === "ok") {
			expect(result.typescriptSource).toBe("managed-runtime");
			expect(result.typescriptVersion).toMatch(/^\d+\.\d+/u);
			const [base] = result.items;
			expect(base.kind).toBe("class");
			expect(base.selectionRange).toEqual({ start: { line: 3, character: 22 }, end: { line: 3, character: 31 } });
		}
	});

	it("finds the implements target of an abstract class", () => {
		expect(names(ask("supertypes", "src/base.ts", 3, 24))).toEqual(["Shape:implements@src/base.ts"]);
	});

	it("finds subtypes through alias, re-export and namespace import, and ignores structurally equal classes", () => {
		const result = ask("subtypes", "src/base.ts", 3, 24);

		expect(names(result).sort()).toEqual([
			"Circle:extends@src/circle.ts",
			"Square:extends@src/square.ts",
			"Triangle:extends@src/ns.ts",
		]);
	});

	it("lists implementing classes as subtypes of an interface but not classes that merely have the same shape", () => {
		const result = ask("subtypes", "src/base.ts", 0, 18);

		expect(names(result)).toEqual(["BaseShape:implements@src/base.ts"]);
	});

	it("terminates on a cyclic interface hierarchy", () => {
		expect(names(ask("supertypes", "src/cycle.ts", 0, 18))).toEqual(["B:extends@src/cycle.ts"]);
		expect(names(ask("subtypes", "src/cycle.ts", 0, 18))).toEqual(["B:extends@src/cycle.ts"]);
	});

	it("reports an unresolvable heritage expression instead of dropping or guessing it", () => {
		const result = ask("supertypes", "src/mixin.ts", 3, 14);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.items).toEqual([]);
			expect(result.warnings.join("\n")).toContain("not a statically resolvable class or interface");
		}
	});

	it("searches other projects for subtypes only when their configuration is supplied", () => {
		const without = ask("subtypes", "src/base.ts", 3, 24);
		const withProject = ask("subtypes", "src/base.ts", 3, 24, { projectConfigs: ["packages/b/tsconfig.json"] });

		expect(names(without)).not.toContain("Child:extends@packages/b/src/child.ts");
		expect(names(withProject)).toContain("Child:extends@packages/b/src/child.ts");
		if (withProject.status === "ok")
			expect(withProject.projects).toEqual(["tsconfig.json", "packages/b/tsconfig.json"]);
	});

	it.each(["source", "configuration"] as const)("invalidates cached compiler results after %s changes", (change) => {
		const path = change === "source" ? "src/circle.ts" : "tsconfig.json";
		const target = join(root, path);
		const before = FILES[path];
		const originalStat = statSync(target);
		try {
			expect(names(ask("subtypes", "src/base.ts", 3, 24))).toContain("Circle:extends@src/circle.ts");
			const changed =
				change === "source"
					? before.replace("extends B", "extends X")
					: JSON.stringify({ ...JSON.parse(TSCONFIG), exclude: ["src/circle.ts"] });
			writeFileSync(target, changed);
			utimesSync(target, originalStat.atime, originalStat.mtime);
			expect(names(ask("subtypes", "src/base.ts", 3, 24))).not.toContain("Circle:extends@src/circle.ts");
		} finally {
			writeFileSync(target, before);
		}
		expect(names(ask("subtypes", "src/base.ts", 3, 24))).toContain("Circle:extends@src/circle.ts");
	});

	it("says so when the position is not inside a class or interface", () => {
		const result = ask("supertypes", "src/mixin.ts", 0, 12);

		expect(result.status).toBe("not_a_type");
	});

	it("reports environment_blocked when no TypeScript compiler can be found", () => {
		const result = analyzeHeritage({
			workspaceRoot: root,
			path: "src/circle.ts",
			position: { line: 1, character: 14 },
			direction: "supertypes",
			runtimeRoots: [],
		});

		// The temporary workspace has no node_modules; the repository's compiler is not a fallback.
		expect(result.status).toBe("environment_blocked");
	});
});
