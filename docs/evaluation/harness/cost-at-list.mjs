// Per-workflow cost of a chat at Token Factory's public list prices, cached input included, from the saved run records.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const RUNS = 'C:/eval/runs';
const PRICES = {
	'nvidia/Nemotron-3_5-Lightning': { in: 0.06, cached: 0.03, out: 0.24 },
	'nvidia/Nemotron-3-Ultra-550b-a55b': { in: 1, cached: 0.12, out: 3 },
	'nvidia/Nemotron-3.5-Super-VL': { in: 0.3, cached: 0.06, out: 0.9 },
	'deepseek-ai/DeepSeek-V4.1-Flash-1017': { in: 0.3, cached: 0.006, out: 1.2 },
};
const list = (byModel) => {
	let total = 0, counter = 0;
	for (const [m, r] of Object.entries(byModel ?? {})) {
		const p = PRICES[m.replace(/^nebius\//, '')];
		if (!p) continue;
		total += ((r.input || 0) * p.in + (r.cacheRead || 0) * p.cached + (r.output || 0) * p.out) / 1e6;
		counter += r.cost || 0;
	}
	return { total, counter };
};
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const group = (label, dir, test = () => true) => {
	const p = join(RUNS, dir);
	if (!existsSync(p)) { console.log(label, 'no folder', dir); return; }
	const rows = readdirSync(p).filter((f) => f.endsWith('.json') && !/grades|results|manual|schedule\.json|handoff\.json/.test(f) && test(f)).map((f) => {
		try { return JSON.parse(readFileSync(join(p, f), 'utf8')); } catch { return null; }
	}).filter((r) => r?.byModel);
	const costs = rows.map((r) => list(r.byModel));
	console.log(label.padEnd(46), 'runs', String(rows.length).padEnd(4), 'list mean', mean(costs.map((c) => c.total)).toFixed(4), 'median', median(costs.map((c) => c.total)).toFixed(4), '| counter mean', mean(costs.map((c) => c.counter)).toFixed(4), 'median', median(costs.map((c) => c.counter)).toFixed(4));
};
group('Google + Tavily, first 100', 'search-google-tavily');
group('Google + Tavily, second 100', 'search-google-tavily-b');
group('Bing + free Tavily, Lightning', 'search-myharness');
group('Bing + free Tavily, Ultra', 'search-myharness-ultra');
group('No search', 'search-closed');
group('Website after fixes', 'browser-fixed');
group('Handoff with the person', 'handoff-fixed');
group('Vision', 'vision');
group('Exam report alone', 'subagent', (f) => f.startsWith('single'));
group('Exam report, main chat only, 3 sub-agents', 'subagent', (f) => f.startsWith('parallel'));
group('Scheduling, Lightning', 'schedule', (f) => /^schedule-(r|explicit|remind|weekdays|at-r)/.test(f));
group('Scheduling, DeepSeek', 'schedule', (f) => /^schedule-flash/.test(f));
