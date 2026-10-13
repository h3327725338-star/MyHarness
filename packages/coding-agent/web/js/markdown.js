// Markdown rendering (marked + highlight.js, both vendored with the HTML export). Raw HTML is escaped, never rendered.
import { yieldToMain } from "./scheduling.js";
import { h } from "/vendor/preact.js";
import { Component } from "/vendor/preact.js";
import { t } from "./i18n.js";
import { looseStrong } from "./util.js";
import { localLinkPath } from "./local-file-links.js";
import { linkifyLocalFiles, openLocalFile, showLocalFileMenu } from "./local-files.js";
import { exportReadOnly } from "./export-mode.js";
import { activeSlotId } from "./store.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const SAFE_LINK = /^(https?:|mailto:|#|\/(?!\/)|\.{0,2}\/)/i;

let engine;
function getEngine() {
	if (engine) return engine;
	const marked = globalThis.marked;
	if (!marked) return null;
	engine = new marked.Marked({ gfm: true, breaks: false, async: false });
	engine.use({
		renderer: {
			html({ text }) {
				return esc(text);
			},
			code({ text, lang }) {
				const language = (lang || "").trim().split(/\s+/)[0];
				return `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(language || "text")}</span><button class="code-copy" type="button">${esc(t("Copy"))}</button></div><pre><code class="hljs">${highlight(text, language)}</code></pre></div>`;
			},
			codespan({ text }) {
				return `<code>${esc(text)}</code>`;
			},
			link({ href, title, tokens }) {
				const inner = this.parser.parseInline(tokens);
				const local = localLinkPath(href);
				// A read-only export copy cannot open local files, so a local-path link degrades to its plain text (D-18).
				if (local) return exportReadOnly() ? inner : `<a href="#" data-local-path="${esc(local)}" title="${esc(local)}">${inner}</a>`;
				if (!SAFE_LINK.test(href || "")) return inner;
				const external = /^https?:/i.test(href);
				return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${inner}</a>`;
			},
			image({ href, text }) {
				// Remote images are blocked by the page CSP; keep the information as a link.
				return SAFE_LINK.test(href || "") ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text || href)}</a>` : esc(text || "");
			},
			table(token) {
				const head = token.header.map((cell, i) => `<th${token.align[i] ? ` style="text-align:${token.align[i]}"` : ""}>${this.parser.parseInline(cell.tokens)}</th>`).join("");
				const body = token.rows.map((row) => `<tr>${row.map((cell, i) => `<td${token.align[i] ? ` style="text-align:${token.align[i]}"` : ""}>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`).join("");
				return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
			},
		},
	});
	// Bold next to punctuation (see looseStrong): tried before the standard emphasis rules.
	class Tokenizer extends marked.Tokenizer {
		emStrong(src, maskedSrc, prevChar) {
			const strong = looseStrong(src, prevChar);
			if (strong) return { type: "strong", raw: strong.raw, text: strong.text, tokens: this.lexer.inlineTokens(strong.text) };
			return super.emStrong(src, maskedSrc, prevChar);
		}
	}
	engine.setOptions({ tokenizer: new Tokenizer() });
	return engine;
}

export function highlight(code, language) {
	const lib = globalThis.hljs;
	try {
		if (lib && language && lib.getLanguage(language)) return lib.highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		// fall through to plain text
	}
	return esc(code);
}

const cache = new Map();
// W110-BEGIN: wrapPatchBlocks (extracted verbatim by data/webui-2026-10-11/perf/W110-repro.mjs; keep self-contained)
const PATCH_BEGIN = /^\*\*\*\s*Begin Patch\s*$/;
const PATCH_END = /^\*\*\*\s*End Patch\s*$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const fenceLine = (line) => FENCE_LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line);

/**
 * Wrap `*** Begin Patch … *** End Patch` regions in a ```diff fence so marked renders them as one diff code
 * block instead of bare paragraphs and list items. Only a marker at column 0 starts or ends a block (an
 * indented marker inside a list is left alone); markers already inside a fenced code block are ignored, and
 * inline code never matches because the whole line must be exactly the marker. Block lines are kept verbatim
 * and the fence is one backtick longer than the longest backtick run inside. Without an End marker (a reply
 * still streaming, or truncated) everything from Begin to the end of the text is wrapped, unless the text
 * runs more than 4000 lines past Begin, in which case the Begin is left as ordinary text.
 */
export function wrapPatchBlocks(text) {
	const lines = String(text).split("\n");
	const out = [];
	let fence = null; // { char, length } of the fenced code block we are inside, or null
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const stripped = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (fence) {
			out.push(line);
			const match = fenceLine(line);
			if (match && match[1][0] === fence.char && match[1].length >= fence.length && match[2].trim() === "") fence = null;
			i++;
			continue;
		}
		const match = fenceLine(line);
		if (match && (match[1][0] !== "`" || !match[2].includes("`"))) {
			fence = { char: match[1][0], length: match[1].length };
			out.push(line);
			i++;
			continue;
		}
		if (!PATCH_BEGIN.test(stripped)) {
			out.push(line);
			i++;
			continue;
		}
		// The patch body is verbatim content: scan for End without tracking fences inside.
		let end = -1;
		const limit = Math.min(lines.length, i + 1 + 4000);
		for (let j = i + 1; j < limit; j++) {
			const candidate = lines[j].endsWith("\r") ? lines[j].slice(0, -1) : lines[j];
			if (PATCH_END.test(candidate)) {
				end = j;
				break;
			}
		}
		if (end === -1 && limit < lines.length) {
			out.push(line);
			i++;
			continue;
		}
		const last = end === -1 ? lines.length - 1 : end;
		let longest = 0;
		for (let j = i; j <= last; j++) {
			const runs = lines[j].match(/`+/g);
			if (runs) for (const run of runs) longest = Math.max(longest, run.length);
		}
		const fenceStr = "`".repeat(Math.max(3, longest + 1));
		out.push(`${fenceStr}diff`);
		for (let j = i; j <= last; j++) out.push(lines[j]);
		out.push(fenceStr);
		i = last + 1;
	}
	return out.join("\n");
}
// W110-END
export function renderMarkdown(text, { breaks = false } = {}) {
	const key = `${breaks ? "breaks" : "normal"}\0${text}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const md = getEngine();
	let out;
	try {
		out = md ? md.parse(wrapPatchBlocks(text), { breaks }) : `<pre>${esc(text)}</pre>`;
	} catch {
		out = `<pre>${esc(text)}</pre>`;
	}
	cache.set(key, out);
	if (cache.size > 300) cache.delete(cache.keys().next().value);
	return out;
}

export async function renderMarkdownAsync(text, { breaks = false } = {}, cancelled = () => false) {
	const key = `${breaks ? "breaks" : "normal"}\0${text}`;
	if (cache.has(key)) return cache.get(key);
	await yieldToMain();
	const md = getEngine();
	if (!md) return `<pre>${esc(text)}</pre>`;
	try {
		const options = { ...md.defaults, breaks };
		const tokens = md.lexer(wrapPatchBlocks(text), options);
		const chunks = [];
		for (const token of tokens) {
			if (cancelled()) return null;
			const batch = [token];
			batch.links = tokens.links;
			chunks.push(md.parser(batch, options));
			await yieldToMain();
		}
		const out = chunks.join("");
		cache.set(key, out);
		if (cache.size > 300) cache.delete(cache.keys().next().value);
		return out;
	} catch { return `<pre>${esc(text)}</pre>`; }
}

/** Markdown block. A delegated click handles the code copy buttons; nothing in the text opens a panel. */
export class Markdown extends Component {
	root = null;
	generation = 0;
	slot = null;
	parseGeneration = 0;
	state = { parsed: null };
	componentDidMount() { this.parseLarge(); this.linkify(); }
	componentDidUpdate(previous) {
		if (previous.text !== this.props.text || previous.breaks !== this.props.breaks) this.parseLarge();
		this.linkify();
	}
	componentWillUnmount() { this.generation++; this.parseGeneration++; }
	parseLarge() {
		const generation = ++this.parseGeneration;
		const { text = "", breaks = false } = this.props;
		if (text.length < 16000) return;
		void renderMarkdownAsync(text, { breaks }, () => generation !== this.parseGeneration).then((html) => {
			if (generation === this.parseGeneration && html !== null) this.setState({ parsed: { text, breaks, html } });
		});
	}
	linkify() {
		const generation = ++this.generation;
		this.slot = activeSlotId();
		if (this.root) void linkifyLocalFiles(this.root, this.slot, () => generation === this.generation);
	}
	onContextMenu = (event) => {
		const link = event.target.closest?.("[data-local-path]");
		if (link) void showLocalFileMenu(event, link.dataset.localPath, this.slot);
	};
	shouldComponentUpdate(next, state) {
		return state !== this.state || next.text !== this.props.text || next.class !== this.props.class || next.breaks !== this.props.breaks;
	}
	onClick = (event) => {
		const link = event.target.closest?.("[data-local-path]");
		if (link) { event.preventDefault(); void openLocalFile(link.dataset.localPath, this.slot); return; }
		const copy = event.target.closest?.(".code-copy");
		if (copy) {
			const code = copy.closest(".code-block")?.querySelector("code");
			navigator.clipboard?.writeText(code?.textContent || "").then(() => {
				copy.textContent = t("Copied");
				setTimeout(() => (copy.textContent = t("Copy")), 1200);
			});
		}
	};
	render({ text, class: cls, breaks = false }) {
		const parsed = this.state.parsed;
		const content = (text || "").length < 16000 ? renderMarkdown(text || "", { breaks }) : parsed?.text === text && parsed.breaks === breaks ? parsed.html : `<pre>${esc(text || "")}</pre>`;
		return h("div", { class: `md ${cls || ""}`, dangerouslySetInnerHTML: { __html: content }, onClick: this.onClick, onContextMenu: this.onContextMenu, ref: (node) => { this.root = node; } });
	}
}

/** Highlight `code` and split it into per-line HTML strings with balanced <span> tags. */
export function highlightLines(code, language) {
	const htmlText = highlight(code, language);
	const lines = [];
	const stack = [];
	let current = "";
	for (const token of htmlText.split(/(<span[^>]*>|<\/span>|\n)/)) {
		if (token === "\n") {
			lines.push(current + "</span>".repeat(stack.length));
			current = stack.join("");
		} else if (token.startsWith("<span")) {
			stack.push(token);
			current += token;
		} else if (token === "</span>") {
			stack.pop();
			current += token;
		} else {
			current += token;
		}
	}
	lines.push(current + "</span>".repeat(stack.length));
	return lines;
}
