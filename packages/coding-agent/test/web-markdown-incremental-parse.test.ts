import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const web = new URL("../web/js/", import.meta.url);
const markdownSource = readFileSync(new URL("markdown.js", web), "utf8")
	.replace(/^import .*;\r?\n/gm, "")
	.replace(/^export /gm, "");

type LexerCall = { src: string; options: unknown };
type ParserCall = { batch: unknown[]; options: unknown };

function makeParas(prefix: string, count: number, filler = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"): string {
	const parts: string[] = [];
	for (let i = 0; i < count; i++) {
		parts.push(`${prefix}-${String(i).padStart(4, "0")}-${filler}`);
	}
	return parts.join("\n\n");
}

function createHarness() {
	const lexerCalls: LexerCall[] = [];
	const parserCalls: ParserCall[] = [];
	class FakeTokenizer {}
	class FakeMarked {
		defaults: Record<string, unknown>;
		constructor(opts: Record<string, unknown> = {}) {
			this.defaults = { ...opts };
		}
		use() {}
		setOptions(opts: Record<string, unknown>) {
			Object.assign(this.defaults, opts);
		}
		lexer(src: string, options: unknown) {
			lexerCalls.push({ src: String(src), options });
			const parts = String(src)
				.split("\n\n")
				.filter((p) => p.length > 0);
			const tokens = parts.map((raw) => {
				const trimmed = raw.trim();
				const isDef = /^\[[^\]]+\]:\s*\S/.test(trimmed);
				return { type: isDef ? "def" : "paragraph", raw, text: raw };
			});
			(tokens as unknown as { links: Record<string, unknown> }).links = {};
			return tokens;
		}
		parser(batch: { raw: string }[], options: unknown) {
			parserCalls.push({ batch: [...batch], options });
			return `<p>${batch[0].raw}</p>`;
		}
		parse(src: string, _options: unknown) {
			const parts = String(src)
				.split("\n\n")
				.filter((p) => p.length > 0);
			return parts.map((raw) => `<p>${raw}</p>`).join("");
		}
	}
	const context = vm.createContext({
		Component: class {
			props: unknown;
			constructor(props: unknown) {
				this.props = props;
			}
		},
		h: (type: string, props: unknown) => ({ type, props }),
		t: (s: string) => s,
		looseStrong: () => null,
		localLinkPath: () => null,
		linkifyLocalFiles: async () => {},
		openLocalFile: async () => {},
		showLocalFileMenu: async () => {},
		exportReadOnly: () => false,
		activeSlotId: () => null,
		yieldToMain: async () => {},
		marked: { Marked: FakeMarked, Tokenizer: FakeTokenizer },
	});
	vm.runInContext(markdownSource, context);
	return {
		context: context as unknown as Record<string, (...args: never[]) => never> & Record<string, unknown>,
		lexerCalls,
		parserCalls,
	};
}

describe("web markdown incremental parse contract", () => {
	it("1: first large render parses every token and joins chunk html", async () => {
		const { context, lexerCalls, parserCalls } = createHarness();
		const T1 = makeParas("t1para", 400);
		expect(T1.length).toBeGreaterThanOrEqual(16000);
		const state = (await (
			context.renderMarkdownAsync as unknown as (t: string, o: unknown) => Promise<Record<string, unknown>>
		)(T1, { breaks: false })) as unknown as {
			text: string;
			breaks: boolean;
			html: string;
			tokens: { raw: string; type: string }[];
			chunks: string[];
		};
		expect(state).not.toBeNull();
		expect(state.tokens.length).toBe(400);
		expect(parserCalls.length).toBe(state.tokens.length);
		expect(lexerCalls.length).toBe(1);
		expect(lexerCalls[0].src).toBe(T1);
		expect(state.html).toBe(state.chunks.join(""));
		expect(state.html).toBe(parserCalls.map((c) => `<p>${(c.batch[0] as { raw: string }).raw}</p>`).join(""));
		expect(state.text).toBe(T1);
		expect(state.breaks).toBe(false);
		// state.html must equal sync renderMarkdown for the same text/breaks.
		expect(state.html).toBe(
			(context.renderMarkdown as unknown as (t: string, o: unknown) => string)(T1, { breaks: false }),
		);
	});

	it("2: growing text lexes whole text but parses only the appended token", async () => {
		const { context, lexerCalls, parserCalls } = createHarness();
		const T1 = makeParas("grow", 400);
		const appendPara = "appended-new-paragraph-zzzzzzzzzzzzzzzz";
		const T2 = `${T1}\n\n${appendPara}`;
		expect(T1.length).toBeGreaterThanOrEqual(16000);
		expect(T2.length).toBeGreaterThanOrEqual(16000);
		const s1 = (await (
			context.renderMarkdownAsync as unknown as (t: string, o: unknown) => Promise<Record<string, unknown>>
		)(T1, { breaks: false })) as unknown as {
			html: string;
			tokens: unknown[];
			chunks: string[];
		};
		const n = s1.tokens.length;
		expect(n).toBe(400);
		const html1 = s1.html;
		lexerCalls.length = 0;
		parserCalls.length = 0;
		const s2 = (await (
			context.renderMarkdownAsync as unknown as (t: string, o: unknown) => Promise<Record<string, unknown>>
		)(T2, {
			breaks: false,
			previous: s1,
		})) as unknown as { html: string; tokens: unknown[]; chunks: string[] };
		expect(lexerCalls.length).toBe(1);
		expect(lexerCalls[0].src).toBe(T2);
		expect(s2.tokens.length).toBe(n + 1);
		expect(parserCalls.length).toBe(1);
		expect((parserCalls[0].batch[0] as { raw: string }).raw).toBe(appendPara);
		expect(s2.chunks.slice(0, n).join("")).toBe(html1);
		expect(s2.html).toBe(`${html1}<p>${appendPara}</p>`);
	});

	it("3: breaks mismatch, non-prefix text and changed token reparse from first difference", async () => {
		const { context, lexerCalls, parserCalls } = createHarness();
		const renderAsync = context.renderMarkdownAsync as unknown as (
			t: string,
			o: unknown,
		) => Promise<{ html: string; breaks: boolean; tokens: { raw: string; type: string }[]; chunks: string[] }>;
		// 3a: same text, different breaks -> full reparse from index 0.
		const base = "alpha-a\n\nbeta-b\n\ngamma-c";
		const sBase = await renderAsync(base, { breaks: false });
		expect(sBase.tokens.length).toBe(3);
		lexerCalls.length = 0;
		parserCalls.length = 0;
		const sBreaks = await renderAsync(base, { breaks: true, previous: sBase });
		expect(sBreaks.breaks).toBe(true);
		expect(parserCalls.length).toBe(3);
		expect((parserCalls[0].batch[0] as { raw: string }).raw).toBe("alpha-a");
		// 3b: previous.text is not a prefix of the new text -> full reparse from index 0.
		lexerCalls.length = 0;
		parserCalls.length = 0;
		const unrelated = "unrelated-1\n\nunrelated-2\n\nunrelated-3";
		const sUnrelated = await renderAsync(unrelated, { breaks: false, previous: sBase });
		expect(sUnrelated.tokens.length).toBe(3);
		expect(parserCalls.length).toBe(3);
		expect((parserCalls[0].batch[0] as { raw: string }).raw).toBe("unrelated-1");
		// 3c: middle token raw changed -> reuse prefix [0], reparse from index 1.
		lexerCalls.length = 0;
		parserCalls.length = 0;
		const base2 = "para-A-111\n\npara-B-222\n\npara-C-333";
		const sBase2 = await renderAsync(base2, { breaks: false });
		lexerCalls.length = 0;
		parserCalls.length = 0;
		const changed = "para-A-111\n\npara-B-222-MODIFIED\n\npara-C-333";
		const sChanged = await renderAsync(changed, { breaks: false, previous: sBase2 });
		expect(sChanged.tokens.length).toBe(3);
		expect(parserCalls.length).toBe(2);
		expect((parserCalls[0].batch[0] as { raw: string }).raw).toBe("para-B-222-MODIFIED");
		expect((parserCalls[1].batch[0] as { raw: string }).raw).toBe("para-C-333");
		expect(sChanged.chunks[0]).toBe(sBase2.chunks[0]);
	});

	it("4: def token in the new list disables reuse and reparses everything", async () => {
		const { context, parserCalls } = createHarness();
		const renderAsync = context.renderMarkdownAsync as unknown as (
			t: string,
			o: unknown,
		) => Promise<{ html: string; tokens: { raw: string; type: string }[]; chunks: string[] }>;
		const base = "defbase-1\n\ndefbase-2\n\ndefbase-3";
		const sBase = await renderAsync(base, { breaks: false });
		expect(sBase.tokens.some((t) => t.type === "def")).toBe(false);
		parserCalls.length = 0;
		const withDef = `${base}\n\n[myid]: https://example.com`;
		const sNew = await renderAsync(withDef, { breaks: false, previous: sBase });
		expect(sNew.tokens.some((t) => t.type === "def")).toBe(true);
		expect(sNew.tokens.length).toBe(4);
		expect(parserCalls.length).toBe(4);
		expect((parserCalls[0].batch[0] as { raw: string }).raw).toBe("defbase-1");
		// Previous list already contains a def -> still no reuse.
		parserCalls.length = 0;
		const grown = `${withDef}\n\ntrailing-para`;
		const sGrown = await renderAsync(grown, { breaks: false, previous: sNew });
		expect(sGrown.tokens.length).toBe(5);
		expect(parserCalls.length).toBe(5);
	});

	it("5: cancelled async render resolves null", async () => {
		const { context, lexerCalls, parserCalls } = createHarness();
		const T = makeParas("cancel", 400);
		const res = await (
			context.renderMarkdownAsync as unknown as (t: string, o: unknown, c: () => boolean) => Promise<unknown>
		)(T, { breaks: false }, () => true);
		expect(res).toBeNull();
		expect(lexerCalls.length).toBe(1);
		expect(parserCalls.length).toBe(0);
	});

	it("6: large render with reusable prefix appends md-pending without pre", async () => {
		const { context } = createHarness();
		const renderAsync = context.renderMarkdownAsync as unknown as (
			t: string,
			o: unknown,
		) => Promise<{ text: string; breaks: boolean; html: string; tokens: unknown[]; chunks: string[] }>;
		const T1 = makeParas("comp6", 400);
		const append = "\n\nAPPENDED-6-NEWPARA";
		const T2 = T1 + append;
		expect(T2.length).toBeGreaterThanOrEqual(16000);
		const s1 = await renderAsync(T1, { breaks: false });
		const Markdown = vm.runInContext("Markdown", context) as new (
			props: unknown,
		) => {
			state: unknown;
			small: unknown;
			render: (props: unknown) => { props: { dangerouslySetInnerHTML: { __html: string } } };
		};
		const inst = new Markdown({ text: T1 }) as unknown as {
			state: { parsed: unknown };
			small: unknown;
			render: (props: { text: string }) => { props: { dangerouslySetInnerHTML: { __html: string } } };
		};
		inst.state = { parsed: s1 };
		inst.small = null;
		const vnode = inst.render({ text: T2 });
		const html = vnode.props.dangerouslySetInnerHTML.__html;
		expect(html).toBe(`${s1.html}<div class="md-pending">${append}</div>`);
		expect(html).not.toContain("<pre");
		expect(html.startsWith(s1.html)).toBe(true);
	});

	it("7: crossing the 16000 threshold keeps sync html and appends md-pending", async () => {
		const { context } = createHarness();
		const smallText = makeParas("cross", 200);
		expect(smallText.length).toBeLessThan(16000);
		const Markdown = vm.runInContext("Markdown", context) as new (props: unknown) => unknown;
		const inst = new Markdown({ text: smallText }) as unknown as {
			state: { parsed: unknown };
			small: unknown;
			render: (props: { text: string }) => { props: { dangerouslySetInnerHTML: { __html: string } } };
		};
		const v1 = inst.render({ text: smallText });
		const html1 = v1.props.dangerouslySetInnerHTML.__html;
		expect(inst.state.parsed).toBeNull();
		expect(html1).toBe(
			(context.renderMarkdown as unknown as (t: string, o: unknown) => string)(smallText, { breaks: false }),
		);
		expect(html1).not.toContain("md-pending");
		expect(html1).not.toContain("<pre");
		const append = `\n\nCROSSING-APPEND-${"y".repeat(6000)}`;
		const largeText = smallText + append;
		expect(largeText.length).toBeGreaterThanOrEqual(16000);
		const v2 = inst.render({ text: largeText });
		const html2 = v2.props.dangerouslySetInnerHTML.__html;
		expect(html2).toBe(`${html1}<div class="md-pending">${append}</div>`);
		expect(html2.startsWith(html1)).toBe(true);
		expect(html2).not.toContain("<pre");
	});

	it("8: unrelated large text falls back to md-pending pure text, never pre", async () => {
		const { context } = createHarness();
		const renderAsync = context.renderMarkdownAsync as unknown as (
			t: string,
			o: unknown,
		) => Promise<{ text: string; breaks: boolean; html: string; tokens: unknown[]; chunks: string[] }>;
		const other = makeParas("other8", 400);
		const sOther = await renderAsync(other, { breaks: false });
		const fresh = makeParas("fresh8", 400);
		expect(fresh.length).toBeGreaterThanOrEqual(16000);
		expect(fresh.startsWith(other)).toBe(false);
		const Markdown = vm.runInContext("Markdown", context) as new (props: unknown) => unknown;
		const inst = new Markdown({ text: fresh }) as unknown as {
			state: { parsed: unknown };
			small: unknown;
			render: (props: { text: string }) => { props: { dangerouslySetInnerHTML: { __html: string } } };
		};
		inst.state = { parsed: sOther };
		inst.small = null;
		const v = inst.render({ text: fresh });
		const html = v.props.dangerouslySetInnerHTML.__html;
		expect(html).toBe(`<div class="md-pending">${fresh}</div>`);
		expect(html).not.toContain("<pre");
		expect(html).not.toContain("<p>");
	});

	it("9: first large render without any reusable prefix shows md-pending, never pre", async () => {
		const { context } = createHarness();
		const T = makeParas("firstbig", 400);
		expect(T.length).toBeGreaterThanOrEqual(16000);
		const Markdown = vm.runInContext("Markdown", context) as new (props: unknown) => unknown;
		const inst = new Markdown({ text: T }) as unknown as {
			state: { parsed: unknown };
			small: unknown;
			render: (props: { text: string }) => { props: { dangerouslySetInnerHTML: { __html: string } } };
		};
		inst.state = { parsed: null };
		inst.small = null;
		const v = inst.render({ text: T });
		const html = v.props.dangerouslySetInnerHTML.__html;
		expect(html).toBe(`<div class="md-pending">${T}</div>`);
		expect(html).not.toContain("<pre");
	});
});
