import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { allToolNames } from "../src/tools/registry.ts";

// SPEC item G: every built-in tool shows a Chinese one-liner in the right sidebar, while the tool definitions
// the model receives stay untouched. Pure node test - no browser, no service, nothing written to disk.
const webDir = new URL("../web/js/", import.meta.url);
const { zhToolDescriptions, zhToolDescription } = await import(new URL("locales/zh-CN-tools.js", webDir).href);
const { zhCN } = await import(new URL("locales/zh-CN.js", webDir).href);
const panelSource = readFileSync(new URL("panel-context.js", webDir), "utf8");

const names = [...(allToolNames as Set<string>)].sort();
const CJK = /[　-〿一-鿿＀-￯]/;
const sentences = zhToolDescriptions as Record<string, string>;
const dictionary = zhCN as Record<string, string>;

/** Every `name: N_("English short sentence")` pair of the sidebar's own English table. */
function englishShortSentences(source: string): Record<string, string> {
	const block = /const TOOL_DESCRIPTIONS = \{([\s\S]*?)\n\};/.exec(source);
	expect(block, "TOOL_DESCRIPTIONS is gone from panel-context.js").not.toBeNull();
	const found: Record<string, string> = {};
	const body = block![1];
	for (const match of body.matchAll(/(\w+):\s*N_\("((?:[^"\\]|\\.)*)"\)/g)) {
		found[match[1]] = JSON.parse(`"${match[2]}"`);
	}
	return found;
}

/**
 * Run one version of panel-context.js in a sandbox and hand back its `toolDescription`, the way
 * test/web-token-count.test.ts does: imports are stripped and the i18n primitives are injected.
 */
function loadToolDescription(
	source: string,
	{ zh, withDictionary }: { zh: boolean; withDictionary?: Record<string, string> },
) {
	const context = vm.createContext({
		N_: (text: string) => text,
		t: (text: string) => (zh && withDictionary ? (withDictionary[text] ?? text) : text),
		isZh: () => zh,
		zhToolDescription: (tool: { name?: string; extension?: boolean }) => (zh ? zhToolDescription(tool) : undefined),
		console,
	});
	const script = `${source.replace(/^import .*;\r?\n/gm, "").replace(/^export (?:default )?/gm, "")}
;globalThis.__toolDescription = toolDescription;
`;
	vm.runInContext(script, context);
	return (context as any).__toolDescription as (tool: unknown) => string;
}

/** The sidebar payload shape `GET /api/resources` returns (src/modes/web/routes-settings.ts). */
const toolObject = (name: string, description: string, extension = false) => ({
	name,
	description,
	active: true,
	source: extension ? "acme-extension" : "builtin",
	extension,
});

describe("Web UI: Chinese tool descriptions (right sidebar, display layer only)", () => {
	it("has one Chinese sentence for every built-in tool name in the registry", () => {
		const missing = names.filter((name) => !(name in sentences));
		expect(missing, `built-in tools without a Chinese description: ${missing.join(", ")}`).toEqual([]);
		expect(names.length).toBeGreaterThanOrEqual(23);
	});

	it("has no entry for a tool that is not built in", () => {
		const extra = Object.keys(sentences).filter((name) => !(allToolNames as Set<string>).has(name));
		expect(extra, `unknown tool names in the table: ${extra.join(", ")}`).toEqual([]);
	});

	it("keeps every sentence within 30 characters and free of implementation detail", () => {
		for (const name of names) {
			const sentence = sentences[name];
			expect(typeof sentence, `${name} is not a string`).toBe("string");
			expect([...sentence].length, `${name} is longer than 30 characters: ${sentence}`).toBeLessThanOrEqual(30);
			expect(CJK.test(sentence), `${name} has no Chinese character: ${sentence}`).toBe(true);
			expect(sentence, `${name} spans several lines`).not.toMatch(/[\n\r]/);
			// One sentence: it ends on a word or a single full stop, never on a stack of marks.
			const tail = sentence.slice(-1);
			expect(/[一-鿿A-Za-z0-9。]/u.test(tail), `${name} ends on punctuation: ${sentence}`).toBe(true);
			expect(/。{2,}/.test(sentence), `${name} stacks full stops: ${sentence}`).toBe(false);
			expect(/[，、；：:;,！!？?~～]$/.test(sentence), `${name} ends on a comma or colon: ${sentence}`).toBe(false);
			// The mechanical renderings the interface dictionary bans (test/web-i18n.test.ts) stay out of these too.
			for (const word of ["提供商", "会话", "思考强度", "工作树", "终端面板"]) {
				expect(sentence, name).not.toContain(word);
			}
			// No parameter names, patch grammar or cost/limit notes in a one-line description.
			expect(
				/[{}<>]|\d+\s*(KB|MiB|token)|offset|limit/i.test(sentence),
				`${name} leaks implementation detail: ${sentence}`,
			).toBe(false);
		}
	});

	it("keeps English developer terms spaced instead of glued to Chinese", () => {
		const terms = ["Agent", "Bash", "PowerShell", "GitHub", "Provider", "Session", "Worktree", "symbols"];
		for (const [name, sentence] of Object.entries(sentences)) {
			for (const term of terms) {
				const glued = new RegExp(`[一-鿿]${term}|${term}[一-鿿]`);
				expect(glued.test(sentence), `${name}: ${sentence}`).toBe(false);
			}
		}
	});

	it("reuses the Chinese already in locales/zh-CN.js for the 15 tools that had one", () => {
		const english = englishShortSentences(panelSource);
		for (const [name, literal] of Object.entries(english)) {
			expect(literal in dictionary, `zh-CN.js lost its entry for ${name}`).toBe(true);
			expect(sentences[name], `${name} drifted away from zh-CN.js`).toBe(dictionary[literal]);
		}
		expect(Object.keys(english).length).toBe(15);
	});

	it("returns undefined for extension tools and unknown names, the table's sentence for built-in ones", () => {
		expect(zhToolDescription(toolObject("acme_widget", "Third-party widget bridge", true))).toBeUndefined();
		expect(zhToolDescription(toolObject("read", "Reads files.", true))).toBeUndefined();
		expect(zhToolDescription(toolObject("acme_widget", "Third-party widget bridge"))).toBeUndefined();
		expect(zhToolDescription(toolObject("no_such_tool", "Some description"))).toBeUndefined();
		expect(zhToolDescription(undefined)).toBeUndefined();
		// Inherited Object.prototype names must not resolve to a sentence.
		expect(zhToolDescription(toolObject("constructor", "Some description"))).toBeUndefined();
		expect(zhToolDescription(toolObject("toString", "Some description"))).toBeUndefined();
		for (const name of names) {
			expect(zhToolDescription(toolObject(name, "Long model description"))).toBe(sentences[name]);
		}
	});

	it("shows the same text as before the change when the interface language is English", () => {
		// Exact table and function from bd974d7; keep the regression runnable in source archives without Git.
		const beforeSource = readFileSync(new URL("fixtures/tool-description-before.txt", import.meta.url), "utf8");
		const previous = loadToolDescription(beforeSource, { zh: false });
		const current = loadToolDescription(panelSource, { zh: false });
		const english = englishShortSentences(beforeSource);
		for (const name of names) {
			const modelText = `Model description for ${name}`;
			const expected = english[name] ?? modelText;
			const currentText = current(toolObject(name, modelText));
			expect(currentText, `${name} changed its English sidebar text`).toBe(previous(toolObject(name, modelText)));
			expect(currentText, `${name} English sidebar text`).toBe(expected);
		}
		// Extension tools and unknown names keep falling back to their own description in English mode as well.
		expect(current(toolObject("acme_widget", "Third-party widget bridge", true))).toBe("Third-party widget bridge");
		expect(current(toolObject("no_such_tool", "Some description"))).toBe("Some description");
	});

	it("shows Chinese for every built-in tool when the interface language is Chinese", () => {
		const current = loadToolDescription(panelSource, { zh: true, withDictionary: dictionary });
		for (const name of names) {
			expect(current(toolObject(name, `Model description for ${name}`)), name).toBe(sentences[name]);
		}
		expect(current(toolObject("acme_widget", "Third-party widget bridge", true))).toBe("Third-party widget bridge");
		expect(current(toolObject("no_such_tool", "Some description"))).toBe("Some description");
	});
});
