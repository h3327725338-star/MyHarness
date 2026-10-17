/**
 * End-to-end checks of the symbols workflow operations against the real
 * language servers installed for this machine's MyHarness (the private
 * runtime under the agent directory). Opt in with
 * MYHARNESS_SYMBOLS_LSP_E2E=1; without the variable, or without an installed
 * server for a language, the cases are skipped. The servers are only read:
 * nothing is installed or downloaded by these tests.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeWorkspaceRoot } from "../../../src/symbols/path-semantics.ts";
import { CodeIntelligenceRuntime } from "../../../src/symbols/runtime/runtime.ts";
import { clearRenamePlans } from "../../../src/symbols/workflow/rename-plans.ts";
import { createApplyRenameToolDefinition } from "../../../src/tools/apply-rename.ts";
import { createSymbolsToolDefinition, type SymbolsToolDetails } from "../../../src/tools/symbols.ts";

const enabled = process.env.MYHARNESS_SYMBOLS_LSP_E2E === "1";
const TSC = fileURLToPath(new URL("../../../../../node_modules/typescript/bin/tsc", import.meta.url));

type Definition = ReturnType<typeof createSymbolsToolDefinition>;

/** The symbols tool on its own runtime, so the language servers can be stopped before the directory is removed. */
function openSymbols(root: string): { symbols: Definition; dispose: () => Promise<void> } {
	const runtime = new CodeIntelligenceRuntime({ workspaceRoot: normalizeWorkspaceRoot(root) });
	return {
		symbols: createSymbolsToolDefinition(root, { codeIntelligence: runtime.services }),
		dispose: () => runtime.dispose(),
	};
}

async function run(definition: Definition, args: Record<string, unknown>) {
	if (args.operation === "status") {
		const result = await definition.execute("call", args as never, undefined, undefined, undefined as never);
		return { text: (result.content[0] as { text: string }).text, details: result.details as SymbolsToolDetails };
	}
	const result = await definition.execute(
		"call",
		{ timeoutMs: 120_000, ...args } as never,
		undefined,
		undefined,
		undefined as never,
	);
	return { text: (result.content[0] as { text: string }).text, details: result.details as SymbolsToolDetails };
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), text, "utf8");
	}
}

const longBody = Array.from({ length: 260 }, (_, index) => `\ttotal += ${index};`).join("\n");

const TS_PROJECT: Record<string, string> = {
	"tsconfig.json": JSON.stringify({
		compilerOptions: {
			strict: true,
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "Bundler",
			noEmit: true,
			experimentalDecorators: true,
		},
		include: ["src"],
	}),
	"src/utils/paths.ts": [
		"/**",
		" * Turn Windows separators into forward slashes so paths compare equal on every platform.",
		" */",
		"export function toPosixPath(input: string): string {",
		'\treturn input.replace(/\\\\/g, "/");',
		"}",
		"",
	].join("\n"),
	// Same words in the name, different behaviour: trims and lower-cases, keeps backslashes.
	"src/legacy/normalize.ts": [
		"/** Lower-case and trim a user supplied label. */",
		"export function normalizePath(label: string): string {",
		"\treturn label.trim().toLowerCase();",
		"}",
		"",
	].join("\n"),
	"src/app/report.ts": [
		"function logged(_target: unknown, _key: string, descriptor: PropertyDescriptor): PropertyDescriptor {",
		"\treturn descriptor;",
		"}",
		"",
		"export class ReportWriter {",
		"\tconstructor(private readonly root: string) {}",
		"",
		"\t/** Target path of a report. */",
		"\ttarget(name: string): string;",
		"\ttarget(name: string, extension: string): string;",
		"\t@logged",
		'\ttarget(name: string, extension = "csv"): string {',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source code, not a template
		"\t\treturn `${this.root}/${name}.${extension}`;",
		"\t}",
		"}",
		"",
		"export function longReport(): number {",
		"\tlet total = 0;",
		longBody,
		"\treturn total;",
		"}",
		"",
	].join("\n"),
	"src/app/main.ts": [
		'import { toPosixPath } from "../utils/paths";',
		'import { ReportWriter } from "./report";',
		"",
		'const writer = new ReportWriter("C:/data");',
		"// toPosixPath is mentioned in this comment",
		'console.log(writer.target("q1"), toPosixPath("a\\\\b"), "toPosixPath");',
		"",
	].join("\n"),
};

describe.skipIf(!enabled)("symbols workflow against the real TypeScript language server", () => {
	let root: string;
	let symbols: Definition;
	let dispose: () => Promise<void>;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "myharness-workflow-e2e-ts-"));
		await writeTree(root, TS_PROJECT);
		({ symbols, dispose } = openSymbols(root));
	}, 120_000);

	afterAll(async () => {
		clearRenamePlans();
		await dispose();
		await rm(root, { recursive: true, force: true });
	});

	it("finds an existing implementation whose name shares no word with the request", async () => {
		const { text, details } = await run(symbols, {
			operation: "find_existing",
			intent: "convert windows backslash separators to forward slashes",
		});
		expect(details.candidateCount).toBeGreaterThan(0);
		const first = text.split("\n").find((line) => /^\s*1[.)]/.test(line)) ?? "";
		expect(first).toContain("toPosixPath");
	}, 180_000);

	it("ranks behaviour above a same-name counterexample", async () => {
		const { text } = await run(symbols, {
			operation: "find_existing",
			intent: "convert windows backslash separators to forward slashes",
			names: ["normalizePath"],
		});
		const posix = text.indexOf("toPosixPath");
		const normalize = text.indexOf("normalizePath(");
		expect(posix).toBeGreaterThanOrEqual(0);
		// The counterexample may be listed, but never above the real implementation.
		if (normalize >= 0) expect(posix).toBeLessThan(normalize);
	}, 180_000);

	it("reads one overloaded, decorated method with its doc comment and every overload", async () => {
		const { text } = await run(symbols, {
			operation: "read_symbol",
			target: { type: "symbol", path: "src/app/report.ts", name: "target" },
		});
		expect(text).toContain("source=semantic");
		expect(text).toContain("Target path of a report.");
		expect(text).toContain("target(name: string): string;");
		expect(text).toContain("target(name: string, extension: string): string;");
		expect(text).toContain("@logged");
		expect(text).toContain("class ReportWriter");
		expect(text).not.toContain("longReport");
	}, 180_000);

	it("cuts a long symbol visibly and says how to continue", async () => {
		const { text, details } = await run(symbols, {
			operation: "read_symbol",
			target: { type: "symbol", path: "src/app/report.ts", name: "longReport" },
			maxLines: 40,
		});
		expect(details.sourceTruncated).toBe(true);
		expect(text).toMatch(/read path=src\/app\/report\.ts offset=\d+ limit=\d+/);
	}, 180_000);

	it("separates certain references from possible text matches", async () => {
		const { text } = await run(symbols, {
			operation: "impact",
			target: { type: "symbol", path: "src/utils/paths.ts", name: "toPosixPath" },
		});
		expect(text).toMatch(/\[references\] \d+ site\(s\) in 2 file\(s\).*\(certain\)/);
		expect(text).toMatch(/\[possible\] 2 text occurrence/);
	}, 180_000);

	it("renames across files, refuses a stale plan, and the project still type-checks", async () => {
		const target = { type: "symbol", path: "src/utils/paths.ts", name: "toPosixPath" };
		const stale = await run(symbols, { operation: "rename_preview", target, newName: "toSlashPath" });
		expect(stale.details.renamePlanId).toBeDefined();
		const mainPath = join(root, "src/app/main.ts");
		const original = await readFile(mainPath, "utf8");
		await writeFile(mainPath, `${original}// edited after the preview\n`, "utf8");
		const applyRename = createApplyRenameToolDefinition(root);
		await expect(
			applyRename.execute("call", { planId: stale.details.renamePlanId! }, undefined, undefined, undefined as never),
		).rejects.toThrow(/nothing was written/);
		expect(await readFile(join(root, "src/utils/paths.ts"), "utf8")).toContain("toPosixPath");

		const fresh = await run(symbols, { operation: "rename_preview", target, newName: "toSlashPath" });
		expect(fresh.details.renameFiles?.map((file) => file.path).sort()).toEqual([
			"src/app/main.ts",
			"src/utils/paths.ts",
		]);
		expect(fresh.text).toContain("[not changed] 2 line(s)");
		await applyRename.execute(
			"call",
			{ planId: fresh.details.renamePlanId! },
			undefined,
			undefined,
			undefined as never,
		);

		const main = await readFile(mainPath, "utf8");
		expect(main).toContain('import { toSlashPath } from "../utils/paths";');
		// Comments and strings are not the symbol: they stay as they were.
		expect(main).toContain("// toPosixPath is mentioned in this comment");
		expect(main).toContain('"toPosixPath")');
		if (existsSync(TSC)) {
			expect(() => execFileSync(process.execPath, [TSC, "-p", root], { stdio: "pipe" })).not.toThrow();
		}
	}, 300_000);

	it("sees files created and deleted outside the agent", async () => {
		const target = { type: "symbol", path: "src/legacy/normalize.ts", name: "normalizePath" };
		const before = await run(symbols, { operation: "impact", target });
		expect(before.text).toMatch(/\[references\] 1 site\(s\) in 1 file/);
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		await writeFile(
			join(root, "src/app/extra.ts"),
			'import { normalizePath } from "../legacy/normalize";\nexport const label = normalizePath(" A ");\n',
			"utf8",
		);
		const created = await run(symbols, { operation: "impact", target });
		expect(created.text).toMatch(/\[references\] 3 site\(s\) in 2 file/);
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		await rm(join(root, "src/app/extra.ts"));
		const deleted = await run(symbols, { operation: "impact", target });
		expect(deleted.text).toMatch(/\[references\] 1 site\(s\) in 1 file/);
	}, 300_000);
});

interface LanguageCase {
	readonly language: string;
	readonly files: Record<string, string>;
	readonly path: string;
	readonly name: string;
	readonly newName: string;
	/** Expected certain reference sites and files of `name` (declaration included). */
	readonly sites: number;
	readonly fileCount: number;
}

const LANGUAGE_CASES: readonly LanguageCase[] = [
	{
		language: "python",
		files: {
			"m.py": 'def load_config(path):\n    """Read config."""\n    return path\n',
			"n.py": 'from m import load_config\nprint(load_config("x"))\n',
		},
		path: "m.py",
		name: "load_config",
		newName: "read_settings",
		sites: 3,
		fileCount: 2,
	},
	{
		language: "go",
		files: {
			"go.mod": "module demo\n\ngo 1.21\n",
			"util.go":
				"package main\n\n// LoadConfig reads the config file.\nfunc LoadConfig(path string) string {\n\treturn path\n}\n",
			"main.go": 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(LoadConfig("x"))\n}\n',
		},
		path: "util.go",
		name: "LoadConfig",
		newName: "ReadSettings",
		sites: 2,
		fileCount: 2,
	},
	{
		language: "rust",
		files: {
			"Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
			"src/util.rs": "/// Read config.\npub fn load_config(path: &str) -> String {\n    path.to_string()\n}\n",
			"src/main.rs": 'mod util;\nfn main() {\n    println!("{}", util::load_config("x"));\n}\n',
		},
		path: "src/util.rs",
		name: "load_config",
		newName: "read_settings",
		sites: 2,
		fileCount: 2,
	},
	{
		language: "php",
		files: {
			"util.php": "<?php\n/** Read config. */\nfunction load_config(string $path): string { return $path; }\n",
			"main.php": '<?php\nrequire_once "util.php";\necho load_config("x");\n',
		},
		path: "util.php",
		name: "load_config",
		newName: "read_settings",
		sites: 2,
		fileCount: 2,
	},
	{
		language: "java",
		files: {
			"src/main/java/demo/Util.java":
				"package demo;\n\npublic class Util {\n    /** Read config. */\n    public static String loadConfig(String path) {\n        return path;\n    }\n}\n",
			"src/main/java/demo/Main.java":
				'package demo;\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println(Util.loadConfig("x"));\n    }\n}\n',
		},
		path: "src/main/java/demo/Util.java",
		name: "loadConfig",
		newName: "readSettings",
		sites: 2,
		fileCount: 2,
	},
	{
		language: "csharp",
		files: {
			"demo.csproj":
				'<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
			"Util.cs":
				"namespace Demo;\npublic static class Util\n{\n    /// <summary>Read config.</summary>\n    public static string LoadConfig(string path) => path;\n}\n",
			"Program.cs":
				'namespace Demo;\npublic static class Program\n{\n    public static void Main() => System.Console.WriteLine(Util.LoadConfig("x"));\n}\n',
		},
		path: "Util.cs",
		name: "LoadConfig",
		newName: "ReadSettings",
		sites: 2,
		fileCount: 2,
	},
];

async function languageAvailable(definition: Definition, language: string): Promise<boolean> {
	const status = await run(definition, { operation: "status" });
	return new RegExp(`\\b${language}\\b`, "i").test(status.text);
}

describe.skipIf(!enabled)("symbols workflow across languages (real language servers)", () => {
	for (const testCase of LANGUAGE_CASES) {
		it(`${testCase.language}: complete cross-file impact and rename plan from a cold start`, async (context) => {
			const root = await mkdtemp(join(tmpdir(), `myharness-workflow-e2e-${testCase.language}-`));
			let disposeCase: (() => Promise<void>) | undefined;
			try {
				await writeTree(root, testCase.files);
				const { symbols, dispose } = openSymbols(root);
				disposeCase = dispose;
				if (!(await languageAvailable(symbols, testCase.language))) {
					context.skip();
					return;
				}
				const target = { type: "symbol", path: testCase.path, name: testCase.name };
				const impact = await run(symbols, { operation: "impact", target });
				expect(impact.text).toContain(
					`[references] ${testCase.sites} site(s) in ${testCase.fileCount} file(s) reported by the language server (certain)`,
				);
				const preview = await run(symbols, { operation: "rename_preview", target, newName: testCase.newName });
				expect(preview.details.renameFiles?.length).toBe(testCase.fileCount);
				expect(preview.text).toContain("completeness=complete");
			} finally {
				clearRenamePlans();
				await disposeCase?.();
				await rm(root, { recursive: true, force: true }).catch(() => undefined);
			}
		}, 300_000);
	}
});
