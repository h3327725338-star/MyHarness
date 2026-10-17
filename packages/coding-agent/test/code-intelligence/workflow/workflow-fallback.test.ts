import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeIntelligenceRouterApi } from "../../../src/symbols/index/router/types.ts";
import { buildQueryTerms, matchTerms, stemWord, wordMatchesStem } from "../../../src/symbols/workflow/terms.ts";
import { createSymbolsToolDefinition, type SymbolsToolDetails } from "../../../src/tools/symbols.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "myharness-workflow-fallback-"));
	roots.push(root);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), text, "utf8");
	}
	return root;
}

/** A router whose language servers are all unavailable: every call fails. */
function unavailableRouter(): CodeIntelligenceRouterApi {
	const fail = async (): Promise<never> => {
		throw new Error("language server unavailable");
	};
	return {
		fileSymbols: fail,
		findDefinition: fail,
		findReferences: fail,
		findImplementations: fail,
		getDiagnostics: fail,
		workspaceSymbols: fail,
		rename: fail,
	};
}

function tool(root: string, router: CodeIntelligenceRouterApi = unavailableRouter()) {
	return createSymbolsToolDefinition(root, {
		codeIntelligence: {
			workspaceRoot: root,
			router,
			supportsSymbolIds: true,
			getStatus: () => ({
				workspaceRoot: root,
				semanticConfigured: false,
				semanticEnabled: false,
				symbolStoreEntryCount: 0,
				languageServers: [],
			}),
		},
	});
}

async function run(
	root: string,
	args: Record<string, unknown>,
): Promise<{ text: string; details: SymbolsToolDetails }> {
	const result = await tool(root).execute("call", args as never, undefined, undefined, undefined as never);
	return { text: (result.content[0] as { text: string }).text, details: result.details as SymbolsToolDetails };
}

const SOURCES = {
	"src/utils/paths.ts": [
		"/**",
		" * Turn Windows separators into forward slashes so paths compare equal on every platform.",
		" */",
		"export function toPosixPath(input: string): string {",
		'\treturn input.replace(/\\\\/g, "/");',
		"}",
		"",
	].join("\n"),
	"src/app/report.ts": [
		"export class ReportWriter {",
		"\tconstructor(private readonly root: string) {}",
		"\ttarget(name: string): string {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source code, not a template
		"\t\treturn `${this.root}/${name}.csv`;",
		"\t}",
		"}",
		"",
	].join("\n"),
};

describe("query terms", () => {
	it("splits identifiers, stems words and adds synonyms and Chinese glossary terms", () => {
		const terms = buildQueryTerms("把 Windows 反斜杠路径读取为统一格式", ["normalizePath"]);
		const stems = terms.map((term) => term.stem);
		expect(stems).toContain(stemWord("normalize"));
		expect(stems).toContain("path");
		expect(stems).toContain("read");
		expect(terms.find((term) => term.stem === "path")?.origin).toBe("name");
	});

	it("matches short stems only as whole words", () => {
		expect(wordMatchesStem("id", "id")).toBe(true);
		expect(wordMatchesStem("identity", "id")).toBe(false);
		expect(wordMatchesStem("normalization", "normaliz")).toBe(true);
		expect(matchTerms("convert the path", buildQueryTerms("path", [])).length).toBe(1);
	});
});

describe("workflow operations without a language server", () => {
	it("find_existing still finds the implementation by text and labels the coverage as text-only", async () => {
		const root = await project(SOURCES);
		const { text, details } = await run(root, {
			operation: "find_existing",
			intent: "convert windows backslash separators to forward slashes",
		});
		expect(text).toContain("completeness=partial");
		expect(text).toContain("toPosixPath");
		expect(text).toMatch(/src\/utils\/paths\.ts/);
		expect(details.candidateCount).toBeGreaterThan(0);
	});

	it("find_existing never claims the project has no implementation", async () => {
		const root = await project(SOURCES);
		const { text, details } = await run(root, {
			operation: "find_existing",
			intent: "compress video frames with a neural codec",
		});
		expect(details.candidateCount).toBe(0);
		expect(text).not.toMatch(/does not exist|no such implementation exists/i);
		expect(text).toMatch(/coverage/i);
	});

	it("read_symbol falls back to a labelled text window instead of failing", async () => {
		const root = await project(SOURCES);
		const { text } = await run(root, {
			operation: "read_symbol",
			target: { type: "symbol", path: "src/utils/paths.ts", name: "toPosixPath" },
		});
		expect(text).toContain("source=lexical");
		expect(text).toContain("completeness=partial");
		expect(text).toContain("export function toPosixPath");
		// The leading doc comment belongs to the slice.
		expect(text).toContain("Turn Windows separators");
	});

	it("impact falls back to text matches and marks every site as possible", async () => {
		const root = await project({
			...SOURCES,
			"src/app/main.ts": 'import { toPosixPath } from "../utils/paths";\nconsole.log(toPosixPath("a"));\n',
		});
		const { text } = await run(root, {
			operation: "impact",
			target: { type: "symbol", path: "src/utils/paths.ts", name: "toPosixPath" },
		});
		expect(text).toContain("completeness=partial");
		expect(text).toContain("src/app/main.ts");
		expect(text).not.toMatch(/\(certain\)/);
	});

	it("rename_preview refuses without a language server and writes nothing", async () => {
		const root = await project(SOURCES);
		const { text, details } = await run(root, {
			operation: "rename_preview",
			target: { type: "symbol", path: "src/utils/paths.ts", name: "toPosixPath" },
			newName: "toSlashPath",
		});
		expect(text).toContain("[refused]");
		expect(details.renameRefused).toBe(true);
		expect(details.renamePlanId).toBeUndefined();
	});
});
