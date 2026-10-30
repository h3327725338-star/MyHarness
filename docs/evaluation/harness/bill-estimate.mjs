// What the tests should have cost at Token Factory's public list prices, including the cached-input price, split by the key change.
// Traces hold chats and sub-agents; provider-spend.json also holds background jobs (titles, memory upkeep), priced with cached input at $0.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = 'C:/eval';
const KEY_CHANGE = Date.parse('2026-10-30T09:50:55Z');
const PRICES = {
	'nvidia/Nemotron-3_5-Lightning': { in: 0.06, cached: 0.03, out: 0.24 },
	'nvidia/Nemotron-3-Ultra-550b-a55b': { in: 1, cached: 0.12, out: 3 },
	'nvidia/Nemotron-3.5-Super-VL': { in: 0.3, cached: 0.06, out: 0.9 },
	'deepseek-ai/DeepSeek-V4.1-Flash-1017': { in: 0.3, cached: 0.006, out: 1.2 },
};
const labs = [...readdirSync(ROOT).filter((n) => /^lab/.test(n)).map((n) => join(ROOT, n)), ...readdirSync('C:/').filter((n) => /^mh-m\d+$/.test(n)).map((n) => `C:/${n}`)];
const blank = () => ({ requests: 0, input: 0, cacheRead: 0, output: 0, counter: 0 });
const eras = { before: {}, after: {} };
const perLab = {};
let spendFiles = 0, spendRequests = 0;
const spendByLab = {};
for (const lab of labs) {
	const name = lab.split(/[\\/]/).pop();
	const f = join(lab, 'agent', 'provider-spend.json');
	if (existsSync(f)) {
		const n = JSON.parse(readFileSync(f, 'utf8')).providers?.nebius;
		if (n) { spendFiles += n.total; spendRequests += n.requests; spendByLab[name] = { total: +n.total.toFixed(3), requests: n.requests }; }
	}
	const traces = join(lab, 'agent', 'traces');
	if (!existsSync(traces)) continue;
	for (const session of readdirSync(traces)) {
		const dir = join(traces, session);
		let files = [];
		try { files = readdirSync(dir).filter((x) => x.endsWith('.jsonl')); } catch { continue; }
		for (const x of files) for (const line of readFileSync(join(dir, x), 'utf8').split('\n')) {
			if (!line.includes('"type":"model-response"')) continue;
			let e; try { e = JSON.parse(line); } catch { continue; }
			const d = e.data || {};
			const u = d.usage || {};
			const era = Date.parse(e.at) >= KEY_CHANGE ? 'after' : 'before';
			const r = (eras[era][d.model] ??= blank());
			r.requests++; r.input += u.input || 0; r.cacheRead += u.cacheRead || 0; r.output += u.output || 0; r.counter += u.cost?.total || 0;
			const l = ((perLab[name] ??= {})[d.model] ??= blank());
			l.requests++; l.input += u.input || 0; l.cacheRead += u.cacheRead || 0; l.output += u.output || 0; l.counter += u.cost?.total || 0;
		}
	}
}
const price = (m, r) => { const p = PRICES[m]; return p ? (r.input * p.in + r.cacheRead * p.cached + r.output * p.out) / 1e6 : 0; };
for (const era of ['before', 'after']) {
	let total = 0, counter = 0;
	console.log(`--- ${era} the key change (chats and sub-agents only)`);
	for (const [m, r] of Object.entries(eras[era])) {
		const list = price(m, r);
		total += list; counter += r.counter;
		console.log(m.split('/').pop().padEnd(30), 'req', String(r.requests).padEnd(5), 'in', (r.input / 1e6).toFixed(2).padStart(6), 'cached', (r.cacheRead / 1e6).toFixed(2).padStart(6), 'out', (r.output / 1e6).toFixed(3).padStart(6), 'counter', r.counter.toFixed(3).padStart(6), 'list', list.toFixed(3).padStart(6));
	}
	console.log('total counter', counter.toFixed(3), 'total at list price', total.toFixed(3));
}
console.log('--- product spend files, all copies, chats + sub-agents + background jobs, cached at $0:', spendFiles.toFixed(3), 'requests', spendRequests);
console.log(JSON.stringify(spendByLab));
const labS3 = perLab.labS3 || {};
let s3 = 0;
for (const [m, r] of Object.entries(labS3)) { s3 += price(m, r); console.log('labS3 chats', m.split('/').pop(), 'req', r.requests, 'in', r.input, 'cached', r.cacheRead, 'out', r.output, 'list', price(m, r).toFixed(4), 'counter', r.counter.toFixed(4)); }
console.log('labS3 chats at list price', s3.toFixed(4), 'per question', (s3 / 200).toFixed(5));
