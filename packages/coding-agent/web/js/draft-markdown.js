// The composer draft drawn as formatted Markdown while it is typed. Pure functions, no DOM: one <div> per source line
// and every character of the source kept, in order, as text. So an offset into the drawing is the same offset into the
// raw draft, and the raw text is what gets sent. Syntax marks are wrapped in `.md-mk`; CSS hides them except on the
// line that has the caret, where they can be seen and edited.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const mark = (s) => (s ? `<span class="md-mk">${esc(s)}</span>` : "");

const INLINE = [
	// `code` (any number of backticks, closed by the same number)
	[/^(`+)(?!`)([\s\S]*?[^`])\1(?!`)/, (m) => `<code class="md-code">${mark(m[1])}${esc(m[2])}${mark(m[1])}</code>`],
	// \* and other escaped punctuation
	[/^\\([!-/:-@[-`{-~])/, (m) => `${mark("\\")}${esc(m[1])}`],
	// **bold** / __bold__
	[/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/, (m) => `<strong>${mark(m[1])}${inline(m[2])}${mark(m[1])}</strong>`],
	// ~~strikethrough~~
	[/^~~(?=\S)([\s\S]*?\S)~~/, (m) => `<del>${mark("~~")}${inline(m[1])}${mark("~~")}</del>`],
	// *italic* / _italic_
	[/^(\*|_)(?=[^\s*_])([\s\S]*?[^\s*_])\1(?![*_])/, (m) => `<em>${mark(m[1])}${inline(m[2])}${mark(m[1])}</em>`],
	// [text](url)
	[/^\[([^\]\n]+)\]\(([^)\s]*)\)/, (m) => `<span class="md-link">${mark("[")}${inline(m[1])}${mark(`](${m[2]})`)}</span>`],
];

/** Inline Markdown of one line: code spans, bold, italic, strikethrough, links; anything else is plain text. */
export function inline(src) {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const rest = src.slice(i);
		// "_" only opens emphasis at the start of a word (snake_case stays plain).
		const wordUnderscore = rest[0] === "_" && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1]);
		let matched = false;
		if (!wordUnderscore) {
			for (const [pattern, draw] of INLINE) {
				const m = pattern.exec(rest);
				if (!m) continue;
				out += draw(m);
				i += m[0].length;
				matched = true;
				break;
			}
		}
		if (matched) continue;
		const plain = /^[^`\\*_~[]+/.exec(rest);
		const take = plain ? plain[0] : rest[0];
		out += esc(take);
		i += take.length;
	}
	return out;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** Each source line with the class that formats it and its HTML (characters unchanged, marks wrapped). */
export function draftLines(text) {
	const lines = String(text).split("\n");
	let fence = null;
	return lines.map((line) => {
		let m;
		if (fence) {
			m = FENCE.exec(line);
			if (m && m[2][0] === fence[0] && m[2].length >= fence.length && !m[3].trim()) {
				fence = null;
				return { cls: "dline-fence dline-fence-end", html: mark(line) };
			}
			return { cls: "dline-code", html: esc(line) };
		}
		if ((m = FENCE.exec(line)) && !(m[2][0] === "`" && m[3].includes("`"))) {
			fence = m[2];
			return { cls: "dline-fence", html: `${mark(m[1] + m[2])}${m[3] ? `<span class="md-lang">${esc(m[3])}</span>` : ""}` };
		}
		if ((m = /^(#{1,6})([ \t]+)(.*)$/.exec(line))) return { cls: `dline-h dline-h${m[1].length}`, html: `${mark(m[1] + m[2])}${inline(m[3])}` };
		if ((m = /^( {0,3}>[ \t]?)(.*)$/.exec(line))) return { cls: "dline-quote", html: `${mark(m[1])}${inline(m[2])}` };
		if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) return { cls: "dline-hr", html: mark(line) };
		if ((m = /^([ \t]*)([-*+])([ \t]+)(.*)$/.exec(line))) {
			return { cls: "dline-li", html: `${esc(m[1])}<span class="md-bullet">${esc(m[2])}</span>${esc(m[3])}${inline(m[4])}` };
		}
		if ((m = /^([ \t]*)(\d{1,9}[.)])([ \t]+)(.*)$/.exec(line))) {
			return { cls: "dline-li dline-ol", html: `${esc(m[1])}<span class="md-num">${esc(m[2])}</span>${esc(m[3])}${inline(m[4])}` };
		}
		return { cls: "", html: inline(line) };
	});
}

/** The whole draft as HTML: one `.dline` block per line; `activeLine` (the caret's line) shows its marks. */
export function renderDraft(text, activeLine = -1) {
	return draftLines(text)
		.map((line, i) => `<div class="dline${line.cls ? ` ${line.cls}` : ""}${i === activeLine ? " active" : ""}">${line.html || "<br>"}</div>`)
		.join("");
}

/** Index of the line that holds `offset`. */
export function lineAt(text, offset) {
	let n = 0;
	for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") n++;
	return n;
}

const graphemes = (s) => {
	if (typeof Intl !== "undefined" && Intl.Segmenter) return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment);
	return Array.from(s);
};

function words(s) {
	if (typeof Intl !== "undefined" && Intl.Segmenter) return [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(s)].map((x) => x.segment);
	return s.match(/\s+|[\p{L}\p{N}_]+|./gu) || [];
}

/**
 * The range a delete key removes with the caret at `pos` (no selection), for an `InputEvent.inputType`: one character
 * (a whole emoji or accented letter), a word, or to the start / end of the line. At a line edge it removes the line break.
 */
export function deletionRange(text, pos, inputType) {
	const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
	const nextBreak = text.indexOf("\n", pos);
	const lineEnd = nextBreak < 0 ? text.length : nextBreak;
	const forward = /Forward$/.test(inputType);
	if (forward ? pos >= lineEnd : pos <= lineStart) return forward ? [pos, Math.min(text.length, pos + 1)] : [Math.max(0, pos - 1), pos];
	if (/^delete(Soft|Hard)Line/.test(inputType)) return forward ? [pos, lineEnd] : [lineStart, pos];
	if (/^deleteWord/.test(inputType)) {
		if (forward) {
			const parts = words(text.slice(pos, lineEnd));
			let end = pos;
			let i = 0;
			while (i < parts.length && !parts[i].trim()) end += parts[i++].length;
			if (i < parts.length) end += parts[i].length;
			return [pos, end];
		}
		const parts = words(text.slice(lineStart, pos));
		let start = pos;
		let i = parts.length - 1;
		while (i >= 0 && !parts[i].trim()) start -= parts[i--].length;
		if (i >= 0) start -= parts[i].length;
		return [start, pos];
	}
	if (forward) return [pos, pos + (graphemes(text.slice(pos, lineEnd))[0]?.length || 1)];
	const before = graphemes(text.slice(lineStart, pos));
	return [pos - (before[before.length - 1]?.length || 1), pos];
}
