// Web search benchmark, baselines on the same model (Nemotron 3.5 Lightning, high) and the same questions:
//  closed: no search at all, the model answers from what it knows;
//  basic:  one Tavily search (keyless, 5 results, snippets only), the way a plain "search then answer" bot works.
// node baselines-search.mjs <sample.json> <outDir> <closed|basic> [concurrency]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSample } from './data.mjs';
import { pool } from './mh.mjs';
import { chat } from './nebius.mjs';
const [sampleFile, outDir, mode, concurrency = '4'] = process.argv.slice(2);
const { sample } = loadSample(sampleFile);
mkdirSync(outDir, { recursive: true });
const LIGHTNING = 'nvidia/Nemotron-3_5-Lightning';
async function tavily(query) {
	const t = Date.now();
	const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Tavily-Access-Mode': 'keyless' }, body: JSON.stringify({ query, search_depth: 'basic', max_results: 5 }) });
	const text = await r.text();
	if (!r.ok) return { error: `Tavily HTTP ${r.status} ${text.slice(0, 200)}`, ms: Date.now() - t };
	return { results: (JSON.parse(text).results || []).map((x) => ({ title: x.title, url: x.url, content: x.content })), ms: Date.now() - t };
}
let done = 0;
const todo = sample.filter((q) => !existsSync(join(outDir, `${q.id}.json`)));
await pool(todo, Number(concurrency), async (q) => {
	const rec = { id: q.id, mode, question: q.problem };
	const t = Date.now();
	if (mode === 'closed') {
		const r = await chat(LIGHTNING, [{ role: 'user', content: `${q.problem}\n\nGive a short, direct answer.` }], { effort: 'high' });
		Object.assign(rec, { answer: r.content, cost: r.cost, usage: r.usage, error: r.error });
	} else {
		const s = await tavily(q.problem);
		rec.search = s;
		if (s.error) rec.error = s.error;
		else {
			const context = s.results.map((x, i) => `[${i + 1}] ${x.title} — ${x.url}\n${x.content}`).join('\n\n');
			const r = await chat(LIGHTNING, [{ role: 'user', content: `Answer the question using these web search results.\n\n${context}\n\nQuestion: ${q.problem}\n\nGive a short, direct answer, with your source.` }], { effort: 'high' });
			Object.assign(rec, { answer: r.content, cost: r.cost, usage: r.usage, error: r.error });
		}
	}
	rec.ms = Date.now() - t;
	writeFileSync(join(outDir, `${q.id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
	done++;
	if (done % 10 === 0 || rec.error) console.log(`${done}/${todo.length} ${q.id}${rec.error ? ' ERROR ' + rec.error.slice(0, 160) : ''}`);
});
console.log('finished');
