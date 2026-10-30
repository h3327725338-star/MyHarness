// Static SVG charts for the evaluation write-up (GitHub shows them as images). Palette: the dataviz reference palette,
// light and dark steps selected separately; one highlighted series (blue), everything else muted; every mark has a
// <title> so hovering the opened SVG shows its exact value, and every chart sits next to a table with the same numbers.
import { writeFileSync } from 'node:fs';

const STYLE = `
	.bg { fill: #fcfcfb; } .t1 { fill: #0b0b0b; } .t2 { fill: #52514e; } .t3 { fill: #6f6e69; }
	.grid { stroke: #e4e3df; } .axis { stroke: #c9c8c2; }
	.hi { fill: #2a78d6; } .mute { fill: #a9a79f; } .ref { fill: #d9d8d2; } .ok { fill: #1baf7a; }
	@media (prefers-color-scheme: dark) {
		.bg { fill: #1a1a19; } .t1 { fill: #f0efec; } .t2 { fill: #c3c2b7; } .t3 { fill: #a3a29a; }
		.grid { stroke: #2f2f2d; } .axis { stroke: #4a4945; }
		.hi { fill: #3987e5; } .mute { fill: #77766f; } .ref { fill: #474641; } .ok { fill: #199e70; }
	}
	text { font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A bar with a 4px rounded data end, square at the baseline. */
function bar(x, y, w, h, cls, title) {
	const r = Math.min(4, w / 2, h / 2);
	const d = w <= 0.5 ? '' : `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
	return `<path class="${cls}" d="${d}"><title>${esc(title)}</title></path>`;
}

/**
 * Horizontal bars. rows: { label, value, max?, text, cls: 'hi'|'mute'|'ref', note?, group? }
 * opts: { title, subtitle, max, ticks: [values], tickFormat, width }
 */
export function hbar(file, rows, opts) {
	const W = opts.width ?? 760, labelW = opts.labelWidth ?? 250, right = 120, top = opts.subtitle ? 64 : 44, rowH = 34, gap = 10;
	let y = top + 16;
	const plotW = W - labelW - right;
	const parts = [];
	let lastGroup;
	for (const r of rows) {
		if (r.group && r.group !== lastGroup) {
			parts.push(`<text class="t3" x="16" y="${y + 12}" font-size="12" font-weight="600" letter-spacing="0.04em">${esc(r.group.toUpperCase())}</text>`);
			y += 22;
			lastGroup = r.group;
		}
		const w = Math.max(0, (r.value / opts.max) * plotW);
		parts.push(`<text class="t1" x="16" y="${y + rowH / 2 + 5}" font-size="14">${esc(r.label)}</text>`);
		if (r.note) parts.push(`<text class="t3" x="16" y="${y + rowH / 2 + 20}" font-size="11">${esc(r.note)}</text>`);
		parts.push(bar(labelW, y + 5, w, rowH - 10, r.cls, `${r.label}: ${r.text}`));
		parts.push(`<text class="${r.cls === 'hi' ? 't1' : 't2'}" x="${labelW + w + 8}" y="${y + rowH / 2 + 5}" font-size="14" font-weight="${r.cls === 'hi' ? 700 : 400}">${esc(r.text)}</text>`);
		y += rowH + gap + (r.note ? 8 : 0);
	}
	const H = y + 30;
	const grid = (opts.ticks ?? []).map((t) => { const x = labelW + (t / opts.max) * plotW; return `<line class="grid" x1="${x}" y1="${top + 8}" x2="${x}" y2="${H - 30}" stroke-width="1"/><text class="t3" x="${x}" y="${H - 12}" font-size="11" text-anchor="middle">${esc(opts.tickFormat ? opts.tickFormat(t) : t)}</text>`; }).join('');
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}">
<style>${STYLE}</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<text class="t1" x="16" y="26" font-size="17" font-weight="700">${esc(opts.title)}</text>
${opts.subtitle ? `<text class="t2" x="16" y="47" font-size="13">${esc(opts.subtitle)}</text>` : ''}
${grid}
<line class="axis" x1="${labelW}" y1="${top + 8}" x2="${labelW}" y2="${H - 30}" stroke-width="1"/>
${parts.join('\n')}
</svg>
`;
	writeFileSync(file, svg);
}
