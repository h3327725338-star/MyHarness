// Unified-diff parsing and rendering (unified and side-by-side).
import { html, memo, useMemo, useState } from "./ui.js";
import { highlight } from "./markdown.js";
import { parsePatch } from "./diff-parse.js";
import { t } from "./i18n.js";

function pairRows(hunk) {
	const rows = [];
	const lines = hunk.lines;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.type === "ctx") {
			rows.push({ left: line, right: line });
			i++;
		} else if (line.type === "meta") {
			i++;
		} else {
			const dels = [];
			const adds = [];
			while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
			while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
			const n = Math.max(dels.length, adds.length);
			for (let k = 0; k < n; k++) rows.push({ left: dels[k] || null, right: adds[k] || null });
		}
	}
	return rows;
}

const MAX_LINES = 900;

function Code({ text, language, plain }) {
	if (plain || !language) return html`<span class="dl-text">${text || " "}</span>`;
	return html`<span class="dl-text hljs" dangerouslySetInnerHTML=${{ __html: highlight(text, language) || " " }} />`;
}

function UnifiedLine({ line, language, plain }) {
	if (line.type === "meta") return html`<div class="dl meta"><span class="dl-no" /><span class="dl-no" /><span class="dl-sign" /><span class="dl-text dim">${line.text}</span></div>`;
	const sign = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
	return html`<div class=${`dl ${line.type}`}>
		<span class="dl-no">${line.oldNo ?? ""}</span><span class="dl-no">${line.newNo ?? ""}</span>
		<span class="dl-sign">${sign}</span><${Code} text=${line.text} language=${language} plain=${plain} />
	</div>`;
}

function SplitRow({ row, language, plain }) {
	const cell = (line, side) =>
		line
			? html`<div class=${`ds-cell ${line.type}`}><span class="dl-no">${side === "l" ? line.oldNo : line.newNo}</span><span class="dl-sign">${line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span><${Code} text=${line.text} language=${language} plain=${plain} /></div>`
			: html`<div class="ds-cell empty"><span class="dl-no" /><span class="dl-sign" /><span class="dl-text" /></div>`;
	return html`<div class="ds-row">${cell(row.left, "l")}${cell(row.right, "r")}</div>`;
}

export const DiffView = memo(function DiffView({ patch, mode = "unified", language }) {
	const hunks = useMemo(() => parsePatch(patch), [patch]);
	const [limit, setLimit] = useState(MAX_LINES);
	const total = hunks.reduce((n, h) => n + h.lines.length, 0);
	const plain = total > 2500;
	let budget = limit;
	if (!hunks.length) return html`<div class="diff-empty dim">${t("No textual changes.")}</div>`;
	return html`<div class=${`diff ${mode}`}>
		${hunks.map((hunk, index) => {
			if (budget <= 0) return null;
			const slice = hunk.lines.slice(0, budget);
			budget -= slice.length;
			const shown = { ...hunk, lines: slice };
			return html`<div class="hunk" key=${index}>
				<div class="hunk-head"><span>@@ −${hunk.oldStart} +${hunk.newStart} @@</span><span class="dim truncate">${hunk.section}</span></div>
				${mode === "split"
					? pairRows(shown).map((row, i) => html`<${SplitRow} key=${i} row=${row} language=${language} plain=${plain} />`)
					: slice.map((line, i) => html`<${UnifiedLine} key=${i} line=${line} language=${language} plain=${plain} />`)}
			</div>`;
		})}
		${total > limit ? html`<button class="btn sm ghost diff-more" onClick=${() => setLimit(limit + MAX_LINES)}>${t("Show more ({limit} lines)", { limit: total - limit })}</button>` : null}
	</div>`;
});

export { parsePatch };

export function languageFor(path) {
	const ext = (path.split(".").pop() || "").toLowerCase();
	const map = { ts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", json: "json", md: "markdown", py: "python", rs: "rust", go: "go", java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp", css: "css", html: "xml", xml: "xml", yml: "yaml", yaml: "yaml", toml: "ini", sh: "bash", ps1: "powershell", sql: "sql", rb: "ruby", php: "php", swift: "swift", kt: "kotlin" };
	return map[ext];
}
