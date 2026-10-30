// Everything sent with the user's own key (the runs after 2026-10-30 17:50 MYT): tokens per model and the cost range,
// from the copies' traces and spend counters. Direct grader calls are logged by nebius.mjs callers, not here.
// node spend-since-key.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = 'C:/eval';
const SINCE = Date.parse('2026-10-30T09:50:55Z');
const PRICES = { 'nvidia/Nemotron-3_5-Lightning': [0.06, 0.24], 'nvidia/Nemotron-3-Ultra-550b-a55b': [1, 3], 'nvidia/Nemotron-3.5-Super-VL': [0.3, 0.9], 'deepseek-ai/DeepSeek-V4.1-Flash-1017': [0.3, 1.2] };
const labs = [join(ROOT, 'labA'), join(ROOT, 'labS3'), ...Array.from({ length: 15 }, (_, i) => `C:/eval/memory-copy-${i + 5}`)];
const rows = {};
for (const lab of labs) {
	const traces = join(lab, 'agent', 'traces');
	if (!existsSync(traces)) continue;
	for (const session of readdirSync(traces)) {
		const dir = join(traces, session);
		let files = [];
		try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && statSync(join(dir, f)).mtimeMs >= SINCE); } catch { continue; }
		for (const f of files) for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
			if (!line.includes('"type":"model-response"')) continue;
			let e; try { e = JSON.parse(line); } catch { continue; }
			const when = Date.parse(e.ts || e.timestamp || e.time || '') || 0;
			if (when && when < SINCE) continue;
			const d = e.data || {};
			const u = d.usage || {};
			const r = (rows[d.model] ??= { requests: 0, failed: 0, input: 0, cacheRead: 0, output: 0, counter: 0 });
			r.requests++;
			if (d.status && d.status !== 'completed') r.failed++;
			r.input += u.input || 0; r.cacheRead += u.cacheRead || 0; r.output += u.output || 0; r.counter += u.cost?.total || 0;
		}
	}
}
let free = 0, full = 0;
for (const [model, r] of Object.entries(rows)) {
	const [pi, po] = PRICES[model] || [0, 0];
	r.cacheFree = +((r.input * pi + r.output * po) / 1e6).toFixed(4);
	r.cacheFull = +(((r.input + r.cacheRead) * pi + r.output * po) / 1e6).toFixed(4);
	r.counter = +r.counter.toFixed(4);
	free += r.cacheFree; full += r.cacheFull;
}
console.log(JSON.stringify(rows, null, 1));
console.log(`cost with cached tokens free: $${free.toFixed(2)} | at full input price: $${full.toFixed(2)}`);
