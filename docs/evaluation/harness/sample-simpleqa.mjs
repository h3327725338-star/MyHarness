// Draws a fixed random sample from OpenAI's SimpleQA test set (seeded, so anyone gets the same questions).
// node sample-simpleqa.mjs <csv or csv.gz> <n> <seed> [offset] [idPrefix] > sample.json
// With an offset it takes the next questions of the same shuffle, so a second sample shares nothing with the first.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const [file, n = '100', seed = '20261030', offset = '0', idPrefix = 'sqa'] = process.argv.slice(2);
function parseCsv(text) {
	const rows = []; let row = []; let field = ''; let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') { row.push(field); field = ''; }
		else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
		else if (c !== '\r') field += c;
	}
	if (field || row.length) { row.push(field); rows.push(row); }
	return rows;
}
const raw = readFileSync(file);
const rows = parseCsv((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
const [header, ...data] = rows;
const items = data.filter((r) => r.length === 3).map((r, index) => ({ index, problem: r[1], answer: r[2], topic: (r[0].match(/'topic': '([^']+)'/) || [])[1] ?? '', answerType: (r[0].match(/'answer_type': '([^']+)'/) || [])[1] ?? '' }));
let s = Number(seed) >>> 0;
const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const order = items.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
const sample = order.slice(Number(offset), Number(offset) + Number(n)).map((i, k) => ({ id: `${idPrefix}-${String(k + 1).padStart(3, '0')}`, ...items[i] }));
console.log(JSON.stringify({ source: 'https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv', total: items.length, seed: Number(seed), offset: Number(offset), sample }, null, 1));
