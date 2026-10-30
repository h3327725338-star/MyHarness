// Per-model, per-job usage across every evaluation copy, from the copies' own traces (agent/traces/*/run-*.jsonl,
// model-response events) and background memory logs. Costs are MyHarness's spend counter at Token Factory list prices.
// node usage-by-model.mjs > out/usage-by-model.json
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = process.env.EVAL_ROOT || 'C:/eval';
// The memory re-runs sit in short folders on the same drive (C:/eval/memory-copy-<n>), so that one copy cannot find another by searching
// the parent folder.
const LABS = [
	...readdirSync(ROOT).filter((n) => /^lab/.test(n) && existsSync(join(ROOT, n, 'agent'))),
	...readdirSync('C:/').filter((n) => /^mh-m\d+$/.test(n) && existsSync(join('C:/', n, 'agent'))).map((n) => join('C:/', n)),
];
const rows = new Map();
const add = (model, role, u, durationMs) => {
	const key = `${model}|${role}`;
	const r = rows.get(key) ?? { model, role, requests: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, cost: 0, durations: [] };
	r.requests++;
	r.input += u.input || 0;
	r.cacheRead += u.cacheRead || 0;
	r.output += u.output || 0;
	r.reasoning += u.reasoning || 0;
	r.cost += u.cost?.total || 0;
	if (durationMs) r.durations.push(durationMs);
	rows.set(key, r);
};
const roles = new Set();
for (const lab of LABS) {
	const traces = join(ROOT, lab, 'agent', 'traces');
	if (!existsSync(traces)) continue;
	for (const session of readdirSync(traces)) {
		const dir = join(traces, session);
		let files = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
		} catch {
			continue;
		}
		for (const f of files) {
			for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
				if (!line.includes('"type":"model-response"')) continue;
				let e;
				try {
					e = JSON.parse(line);
				} catch {
					continue;
				}
				const d = e.data || {};
				if (d.status && d.status !== 'completed') continue;
				roles.add(e.role);
				add(d.model, e.role || 'unknown', d.usage || {}, d.durationMs);
			}
		}
	}
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const out = [...rows.values()].map(({ durations, ...r }) => ({ ...r, cost: +r.cost.toFixed(4), medianSeconds: durations.length ? +(median(durations) / 1000).toFixed(1) : null })).sort((a, b) => b.cost - a.cost);
const totals = {};
for (const r of out) { const t = (totals[r.model] ??= { requests: 0, input: 0, cacheRead: 0, output: 0, cost: 0 }); t.requests += r.requests; t.input += r.input; t.cacheRead += r.cacheRead; t.output += r.output; t.cost = +(t.cost + r.cost).toFixed(4); }
const spend = {};
for (const lab of LABS) { const f = join(ROOT, lab, 'agent', 'provider-spend.json'); if (existsSync(f)) spend[lab] = JSON.parse(readFileSync(f, 'utf8')).providers?.nebius ?? null; }
const result = { labs: LABS, byModelAndJob: out, byModel: totals, spendCounters: spend, spendTotal: +Object.values(spend).reduce((a, s) => a + (s?.total || 0), 0).toFixed(4) };
writeFileSync(join(ROOT, 'out', 'usage-by-model.json'), `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ byModel: totals, spendTotal: result.spendTotal, jobs: out.map((r) => `${r.model.replace('nvidia/', '')} ${r.role}: ${r.requests} req, $${r.cost}`) }, null, 1));
