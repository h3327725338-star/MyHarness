// Markdown rendering (marked + highlight.js, both vendored with the HTML export). Raw HTML is escaped, never rendered.
import { yieldToMain } from "./scheduling.js";
import { h } from "/vendor/preact.js";
import { Component } from "/vendor/preact.js";
import { t } from "./i18n.js";
import { looseStrong } from "./util.js";
import { localLinkPath } from "./local-file-links.js";
import { linkifyLocalFiles, openLocalFileInWorkspace, showLocalFileMenu } from "./local-files.js";
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

/** Text at or above this length is parsed asynchronously so a long answer or reasoning never blocks a frame. */
const LARGE_TEXT = 16000;

const cacheKey = (text, breaks) => `${breaks ? "breaks" : "normal"}\0${text}`;
/**
 * Parsed HTML of large texts, apart from the cache above: every short message rendered after it (another chat, a
 * streaming answer) pushed a long answer out of that one, and a chat that came back showed its long answers as plain
 * text again until they were parsed once more, with another height, moving the reader's place. Least recently used
 * goes first.
 */
const largeCache = new Map();
const LARGE_CACHE_MAX = 32;
function parsedLarge(key) {
	const html = largeCache.get(key);
	if (html === undefined) return undefined;
	largeCache.delete(key);
	largeCache.set(key, html);
	return html;
}
function keepLarge(key, html) {
	largeCache.delete(key);
	largeCache.set(key, html);
	if (largeCache.size > LARGE_CACHE_MAX) largeCache.delete(largeCache.keys().next().value);
}

/** Plain-text HTML for the part of a large text that has no parsed HTML yet: same font, size and wrapping as the
 *  parsed blocks, only the Markdown markers are still literal. Never a monospace, non-wrapping placeholder. Each
 *  blank-line-separated block is its own paragraph with the parsed paragraphs' spacing: one wrapped block drew every
 *  blank line as a full empty line, so a long reasoning text shrank by a few lines the moment its parse landed. */
const pendingHtml = (rest) =>
	rest
		.split(/\n[ \t]*\n\s*/)
		.filter((block) => block.trim())
		.map((block) => `<p class="md-pending">${esc(block)}</p>`)
		.join("");

const isDefinition = (token) => token.type === "def";

/**
 * Render a large text in cooperative slices. The whole text is always lexed — block structure (loose lists, fenced
 * or indented code, `wrapPatchBlocks`) depends on everything above it — but the per-token HTML of every leading token
 * that did not change is reused, so text that only grew pays for the tokens that were appended, not for all of them.
 * `previous` is the state returned by an earlier pass (it may cover less text); the returned state has one HTML chunk
 * per token, or null when this pass was superseded before it finished.
 */
export async function renderMarkdownAsync(text, { breaks = false, previous = null } = {}, cancelled = () => false) {
	const key = cacheKey(text, breaks);
	const cached = parsedLarge(key) ?? cache.get(key);
	if (cached !== undefined) return { text, breaks, html: cached, tokens: null, chunks: null };
	await yieldToMain();
	const md = getEngine();
	if (!md) return { text, breaks, html: pendingHtml(text), tokens: null, chunks: null };
	const options = { ...md.defaults, breaks };
	let tokens;
	try {
		tokens = md.lexer(wrapPatchBlocks(text), options);
	} catch {
		return { text, breaks, html: pendingHtml(text), tokens: null, chunks: null };
	}
	// Reuse is sound while both passes see the same reference definitions: `tokens.links` is document-wide, so a text
	// that defines links parses from scratch.
	const reusable = previous && previous.breaks === breaks && previous.tokens && previous.chunks && previous.tokens.length <= tokens.length && !previous.tokens.some(isDefinition) && !tokens.some(isDefinition) ? previous : null;
	let common = 0;
	if (reusable) {
		const before = reusable.tokens;
		while (common < before.length && before[common].type === tokens[common].type && before[common].raw === tokens[common].raw) common++;
	}
	const chunks = common > 0 ? reusable.chunks.slice(0, common) : [];
	try {
		for (let i = common; i < tokens.length; i++) {
			if (cancelled()) return null;
			const batch = [tokens[i]];
			batch.links = tokens.links;
			chunks.push(md.parser(batch, options));
			await yieldToMain();
		}
	} catch { return { text, breaks, html: pendingHtml(text), tokens: null, chunks: null }; }
	const html = chunks.join("");
	if (text.length >= LARGE_TEXT) keepLarge(key, html);
	else {
		cache.set(key, html);
		if (cache.size > 300) cache.delete(cache.keys().next().value);
	}
	return { text, breaks, html, tokens, chunks };
}

/** Markdown block. A delegated click handles the code copy buttons; nothing in the text opens a panel. */
export class Markdown extends Component {
	root = null;
	generation = 0;
	slot = null;
	parseGeneration = 0;
	/** Last synchronous render of a text shorter than LARGE_TEXT: the growing text crosses the threshold with the
	 *  previous HTML already in hand, so the crossing keeps the finished blocks instead of showing raw text again. */
	small = null;
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
		if (text.length < LARGE_TEXT) return;
		void renderMarkdownAsync(text, { breaks, previous: this.reusable(text, breaks) }, () => generation !== this.parseGeneration).then((state) => {
			if (generation === this.parseGeneration && state !== null) this.setState({ parsed: state });
		});
	}
	/** The newest already-rendered HTML that this text still starts with, in the same line-break mode. */
	reusable(text, breaks) {
		const parsed = this.state.parsed;
		if (parsed && parsed.breaks === breaks && text.startsWith(parsed.text)) return parsed;
		const small = this.small;
		if (small && small.breaks === breaks && text.startsWith(small.text)) return small;
		return null;
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
		// Left click opens the file in the right-hand workspace; the right-click menu keeps the other ways to open it.
		if (link) { event.preventDefault(); void openLocalFileInWorkspace(link.dataset.localPath, this.slot); return; }
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
		const source = text || "";
		let content;
		if (source.length < LARGE_TEXT) {
			content = renderMarkdown(source, { breaks });
			this.small = { text: source, breaks, html: content };
		} else {
			// Parsed before (the chat came back, the turn mounted again): the finished blocks at once, not the plain text.
			const parsed = parsedLarge(cacheKey(source, breaks));
			const base = parsed === undefined ? this.reusable(source, breaks) : null;
			content = parsed ?? (base ? base.html + pendingHtml(source.slice(base.text.length)) : pendingHtml(source));
		}
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
