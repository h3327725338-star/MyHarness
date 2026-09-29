// Markdown rendering (marked + highlight.js, both vendored with the HTML export). Raw HTML is escaped, never rendered.
import { h } from "/vendor/preact.js";
import { Component } from "/vendor/preact.js";
import { t } from "./i18n.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const FILE_REF = /^(?:[A-Za-z]:)?[\w@./\\~+-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?::\d+)?)?$/;
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
				const raw = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
				if (FILE_REF.test(raw) && !/^\d+(\.\d+)+$/.test(raw)) {
					return `<a class="file-ref" data-path="${esc(raw)}" href="#"><code>${text}</code></a>`;
				}
				return `<code>${text}</code>`;
			},
			link({ href, title, tokens }) {
				const inner = this.parser.parseInline(tokens);
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
export function renderMarkdown(text) {
	const key = text;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const md = getEngine();
	let out;
	try {
		out = md ? md.parse(text) : `<pre>${esc(text)}</pre>`;
	} catch {
		out = `<pre>${esc(text)}</pre>`;
	}
	cache.set(key, out);
	if (cache.size > 300) cache.delete(cache.keys().next().value);
	return out;
}

/** Markdown block. Delegated clicks handle code copy buttons and file references. */
export class Markdown extends Component {
	shouldComponentUpdate(next) {
		return next.text !== this.props.text || next.class !== this.props.class;
	}
	onClick = (event) => {
		const copy = event.target.closest?.(".code-copy");
		if (copy) {
			const code = copy.closest(".code-block")?.querySelector("code");
			navigator.clipboard?.writeText(code?.textContent || "").then(() => {
				copy.textContent = t("Copied");
				setTimeout(() => (copy.textContent = t("Copy")), 1200);
			});
			return;
		}
		const ref = event.target.closest?.("a.file-ref");
		if (ref) {
			event.preventDefault();
			this.props.onOpenFile?.(ref.dataset.path);
		}
	};
	render({ text, class: cls }) {
		return h("div", { class: `md ${cls || ""}`, dangerouslySetInnerHTML: { __html: renderMarkdown(text || "") }, onClick: this.onClick });
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
