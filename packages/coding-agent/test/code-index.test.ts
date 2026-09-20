import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/extensions/runtime/types.ts";
import {
	CodeSymbolIndex,
	getCodeIndexPath,
	getCodeLanguage,
	parseCodeSymbols,
} from "../src/symbols/index/code-index.ts";
import { createSymbolsToolDefinition } from "../src/tools/symbols.ts";

let projectDir = "";

afterEach(() => {
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = "";
});

function createProject(): { project: string; agentDir: string } {
	projectDir = mkdtempSync(join(tmpdir(), "myharness-code-index-"));
	const agentDir = join(projectDir, "agent-data");
	mkdirSync(join(projectDir, "src"), { recursive: true });
	return { project: projectDir, agentDir };
}

describe("code symbol index", () => {
	it("extracts definitions, exported symbols, and parent classes", () => {
		const content = [
			"export class UserService {",
			"  async loadUser(id: string) { return id; }",
			"}",
			"export interface User { id: string }",
			"export const createUser = (id: string) => ({ id });",
			"function helper() {}",
		].join("\n");
		const symbols = parseCodeSymbols(content, "typescript", "src/users.ts");

		expect(symbols.find((symbol) => symbol.name === "UserService")).toMatchObject({
			kind: "class",
			exported: true,
		});
		expect(symbols.find((symbol) => symbol.name === "loadUser")).toMatchObject({
			kind: "method",
			parentName: "UserService",
		});
		expect(symbols.find((symbol) => symbol.name === "User")).toMatchObject({
			kind: "interface",
			exported: true,
		});
		expect(symbols.find((symbol) => symbol.name === "createUser")).toMatchObject({
			kind: "function",
			exported: true,
		});
	});

	it("does not persist common credentials in symbol signatures", () => {
		const symbols = parseCodeSymbols(
			'export const API_KEY = "sk-1234567890abcdef";\nconst password = "private-value";\n',
			"typescript",
			"src/config.ts",
		);
		expect(symbols.map((symbol) => symbol.signature).join("\n")).not.toContain("sk-1234567890abcdef");
		expect(symbols.map((symbol) => symbol.signature).join("\n")).not.toContain("private-value");
	});

	it("indexes incrementally, persists metadata, and removes deleted files", async () => {
		const { project, agentDir } = createProject();
		const filePath = join(project, "src", "users.ts");
		writeFileSync(filePath, "export function loadUser() {}\n");
		const stableTime = new Date(1_700_000_000_000);
		utimesSync(filePath, stableTime, stableTime);
		const index = new CodeSymbolIndex({ cwd: project, agentDir });

		const first = await index.ensureFresh();
		expect(first.added).toBe(1);
		expect((await index.findDefinition("loadUser"))[0]?.path).toBe("src/users.ts");
		expect(existsSync(getCodeIndexPath(project, agentDir))).toBe(true);
		const persisted = JSON.parse(readFileSync(getCodeIndexPath(project, agentDir), "utf8")) as {
			files: Record<string, unknown>;
		};
		expect(persisted.files["src/users.ts"]).not.toHaveProperty("content");

		writeFileSync(filePath, "export function saveUser() {}\n");
		const updated = await index.ensureFresh();
		expect(updated.updated).toBe(1);
		expect(await index.findDefinition("loadUser")).toEqual([]);
		expect((await index.findDefinition("saveUser"))[0]?.path).toBe("src/users.ts");

		rmSync(filePath);
		const removed = await index.ensureFresh();
		expect(removed.removed).toBe(1);
		expect(await index.findDefinition("saveUser")).toEqual([]);
	});

	it("rebuilds persisted indexes after parser changes", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(
			join(project, "src", "regex.ts"),
			[`const matcher = /(?:"[^"]*"|'[^']*')/gi;`, "export class AfterRegex {}"].join("\n"),
		);
		const storagePath = getCodeIndexPath(project, agentDir);
		mkdirSync(dirname(storagePath), { recursive: true });
		writeFileSync(storagePath, JSON.stringify({ version: 1, root: project, updatedAt: Date.now(), files: {} }));

		const index = new CodeSymbolIndex({ cwd: project, agentDir });
		expect((await index.findDefinition("AfterRegex"))[0]?.name).toBe("AfterRegex");
	});

	it("loads the persisted index in a new instance and honors ignore and secret exclusions", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(join(project, ".gitignore"), "ignored.ts\nignored-dir/\n");
		writeFileSync(join(project, "src", "main.ts"), "export function main() {}\n");
		writeFileSync(join(project, "ignored.ts"), "export function ignored() {}\n");
		mkdirSync(join(project, "ignored-dir"));
		writeFileSync(join(project, "ignored-dir", "hidden.ts"), "export function hidden() {}\n");
		writeFileSync(join(project, ".env"), "TOKEN=secret\n");

		const first = new CodeSymbolIndex({ cwd: project, agentDir });
		await first.ensureFresh();
		const second = new CodeSymbolIndex({ cwd: project, agentDir });
		expect((await second.findDefinition("main"))[0]?.path).toBe("src/main.ts");
		expect(await second.findDefinition("ignored")).toEqual([]);
		expect(await second.findDefinition("hidden")).toEqual([]);
		expect(await second.searchCode("TOKEN")).toEqual([]);
	});

	it("supports references, text fallback, and rejects paths outside the project", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(join(project, "src", "defs.ts"), "export function loadUser() {}\n");
		writeFileSync(join(project, "src", "use.ts"), "import { loadUser } from './defs';\nloadUser();\n");
		writeFileSync(join(project, "src", "query.sql"), "select loadUser from users;\n");
		writeFileSync(join(project, "src", "notes.ts"), '// loadUser\nconst text = "loadUser";\n');
		const index = new CodeSymbolIndex({ cwd: project, agentDir });

		const references = await index.findReferences("loadUser");
		expect(references.map((reference) => reference.path)).toEqual([
			"src/defs.ts",
			"src/query.sql",
			"src/use.ts",
			"src/use.ts",
		]);
		expect(references[0]?.referenceKind).toBe("definition");
		expect((await index.searchCode("select loadUser")).map((match) => match.path)).toEqual(["src/query.sql"]);
		const aliasRoot = project.replace(/\\/g, "/").toUpperCase();
		expect((await index.findDefinition("loadUser", { path: `${aliasRoot}/SRC/DEFS.TS` }))[0]?.path).toBe(
			"src/defs.ts",
		);
		expect((await index.searchCode("loadUser", { path: `${aliasRoot}/SRC` })).length).toBeGreaterThan(0);
		await expect(index.findSymbol("loadUser", { path: "../" })).rejects.toThrow("当前项目目录");
	});

	it("detects same-size content changes even when the timestamp is unchanged", async () => {
		const { project, agentDir } = createProject();
		const filePath = join(project, "src", "same.ts");
		writeFileSync(filePath, "export function alpha() {}\n");
		const stableTime = new Date(1_700_000_000_000);
		utimesSync(filePath, stableTime, stableTime);
		const index = new CodeSymbolIndex({ cwd: project, agentDir });
		await index.ensureFresh();

		writeFileSync(filePath, "export function omega() {}\n");
		utimesSync(filePath, stableTime, stableTime);
		const refreshed = await index.ensureFresh();

		expect(refreshed.updated).toBe(1);
		expect(await index.findDefinition("alpha")).toEqual([]);
		expect((await index.findDefinition("omega"))[0]?.name).toBe("omega");
	});

	it("preserves old entries when the scan is capped", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(join(project, "src", "a.ts"), "export function first() {}\n");
		writeFileSync(join(project, "src", "b.ts"), "export function second() {}\n");
		await new CodeSymbolIndex({ cwd: project, agentDir, maxFiles: 2 }).ensureFresh();

		const capped = new CodeSymbolIndex({ cwd: project, agentDir, maxFiles: 1 });
		const summary = await capped.ensureFresh();
		expect(summary.limited).toBe(true);
		expect(summary.removed).toBe(0);
		expect((await capped.findDefinition("second"))[0]?.path).toBe("src/b.ts");
	});

	it("keeps definition matching case-sensitive and supports dollar-sign references", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(
			join(project, "src", "symbols.ts"),
			["export function $foo() {}", "export function Foo() {}", "$foo();", "Foo();"].join("\n"),
		);
		const index = new CodeSymbolIndex({ cwd: project, agentDir });

		expect(await index.findDefinition("foo")).toEqual([]);
		expect((await index.findDefinition("Foo"))[0]?.name).toBe("Foo");
		expect((await index.findReferences("$foo")).map((reference) => reference.line)).toEqual([1, 3]);
	});

	it("does not index bare calls as methods and supports Unicode symbols", () => {
		const symbols = parseCodeSymbols(
			["runTask()", "export function 处理() {}", "export class 用户 {}"].join("\n"),
			"typescript",
			"src/unicode.ts",
		);

		expect(symbols.find((symbol) => symbol.name === "runTask")).toBeUndefined();
		expect(symbols.find((symbol) => symbol.name === "处理")).toMatchObject({ kind: "function", exported: true });
		expect(symbols.find((symbol) => symbol.name === "用户")).toMatchObject({ kind: "class", exported: true });
	});

	it("keeps parsing after regex literals containing quotes", () => {
		const symbols = parseCodeSymbols(
			[`const matcher = /(?:"[^"]*"|'[^']*')/gi;`, "export class AfterRegex {}"].join("\n"),
			"typescript",
			"src/regex.ts",
		);

		expect(symbols.find((symbol) => symbol.name === "AfterRegex")).toMatchObject({ kind: "class", exported: true });
	});

	it("keeps parsing after non-BMP characters in comments", () => {
		const symbols = parseCodeSymbols(
			[`// ${String.fromCodePoint(0x1f600)} fake()`, "export function visible() {}"].join("\n"),
			"typescript",
			"src/non-bmp.ts",
		);

		expect(symbols.find((symbol) => symbol.name === "fake")).toBeUndefined();
		expect(symbols.find((symbol) => symbol.name === "visible")).toMatchObject({ kind: "function", line: 2 });
	});

	it("resolves relative agent directories from the process directory", () => {
		const { project } = createProject();
		const index = new CodeSymbolIndex({ cwd: project, agentDir: "relative-agent" });
		expect(isAbsolute(index.getStats().storagePath)).toBe(true);
	});

	it("redacts sensitive values from signatures and source search results", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(join(project, "src", "config.ts"), 'export const privateKey = "TOP_SECRET_DEMO";\n');
		const index = new CodeSymbolIndex({ cwd: project, agentDir });

		const definition = await index.findDefinition("privateKey");
		const matches = await index.searchCode("TOP_SECRET_DEMO");
		expect(definition[0]?.signature).not.toContain("TOP_SECRET_DEMO");
		expect(matches[0]?.text).not.toContain("TOP_SECRET_DEMO");
	});

	it("rejects unsafe regular expressions before scanning source", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(join(project, "src", "main.ts"), "const value = 'aaaaaaaaaaaaaaaa';\n");
		const index = new CodeSymbolIndex({ cwd: project, agentDir });

		await expect(index.searchCode("(a+)+", { regex: true })).rejects.toThrow("长时间阻塞");
	});

	it("marks capped scans as incomplete and reports accurate Go export metadata", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(join(project, "src", "a.ts"), "export function first() {}\n");
		writeFileSync(join(project, "src", "b.ts"), "export function second() {}\n");
		const capped = new CodeSymbolIndex({ cwd: project, agentDir, maxFiles: 1 });
		const cappedSummary = await capped.ensureFresh();
		expect(cappedSummary.limited).toBe(true);

		const goSymbols = parseCodeSymbols(
			["func lower() {}", "func Upper() {}", "type lowerType struct {}", "type UpperType interface {}"].join("\n"),
			"go",
			"src/main.go",
		);
		expect(goSymbols.find((symbol) => symbol.name === "lower")?.exported).toBe(false);
		expect(goSymbols.find((symbol) => symbol.name === "Upper")?.exported).toBe(true);
		expect(goSymbols.find((symbol) => symbol.name === "lowerType")?.exported).toBe(false);
		expect(goSymbols.find((symbol) => symbol.name === "UpperType")?.exported).toBe(true);
	});

	it("serializes rebuilds with other refreshes", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(join(project, "src", "main.ts"), "export function main() {}\n");
		const index = new CodeSymbolIndex({ cwd: project, agentDir });

		const [fresh, rebuilt] = await Promise.all([index.ensureFresh(), index.rebuild()]);
		expect(fresh.fileCount).toBe(1);
		expect(rebuilt.fileCount).toBe(1);
		expect((await index.findDefinition("main"))[0]?.name).toBe("main");
	});

	it("honors cancellation before indexing", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(join(project, "src", "main.ts"), "export function main() {}\n");
		const controller = new AbortController();
		controller.abort();
		await expect(new CodeSymbolIndex({ cwd: project, agentDir }).ensureFresh(controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
	});

	it("exposes symbol queries through the built-in tool", async () => {
		const { project, agentDir } = createProject();
		writeFileSync(join(project, "src", "main.ts"), "export function main() {}\n");
		const definition = createSymbolsToolDefinition(project, { agentDir });
		const result = await definition.execute(
			"test-call",
			{
				operation: "find_definition",
				query: "main",
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(result.content[0]).toMatchObject({ type: "text" });
		const resultText = result.content.find((block) => block.type === "text");
		expect(resultText?.text).toContain("src/main.ts:1");
		expect(result.details?.fileCount).toBe(1);
		const map = await definition.execute(
			"test-map",
			{ operation: "code_map", path: "src" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const mapText = map.content.find((block) => block.type === "text");
		expect(mapText?.text).toContain("src/main.ts");
		const fileSymbols = await definition.execute(
			"test-file-symbols",
			{ operation: "file_symbols", path: "src/main.ts" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const fileSymbolsText = fileSymbols.content.find((block) => block.type === "text");
		expect(fileSymbolsText?.text).toContain("main");
	});
});

describe("code language detection", () => {
	it("recognizes supported source extensions", () => {
		expect(getCodeLanguage("src/index.ts")).toBe("typescript");
		expect(getCodeLanguage("src/main.py")).toBe("python");
		expect(getCodeLanguage("README.md")).toBeUndefined();
	});
});
