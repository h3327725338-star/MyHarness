// Web search benchmark, MyHarness side: every sampled SimpleQA question in a fresh chat of the desktop copy, main chat on
// Nemotron 3.5 Lightning (high), asked the way a user asks for a looked-up answer. Skips questions already recorded.
// node bench-search.mjs <sample.json> <outDir> [concurrency] [devtoolsPort | server URL] [lightning | ultra]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIGHTNING, MH, pool, ULTRA } from './mh.mjs';
import { runTask } from './run-task.mjs';
import { loadSample } from './data.mjs';
const [sampleFile, outDir, concurrency = '4', port = '9353', modelKey = 'lightning'] = process.argv.slice(2);
const model = modelKey === 'ultra' ? ULTRA : LIGHTNING;
const { sample } = loadSample(sampleFile);
const mh = /^http/.test(port) ? new MH(port) : await MH.fromDevtools(Number(port));
export const searchPrompt = (q) => `${q}\n\nLook this up on the web and give a short, direct answer, with your source.`;
const todo = sample.filter((q) => !existsSync(join(outDir, `${q.id}.json`)));
console.log(`${todo.length} of ${sample.length} to run`);
let done = 0;
await pool(todo, Number(concurrency), async (q) => {
	const r = await runTask(mh, { id: q.id, prompt: searchPrompt(q.problem), model, timeoutMs: 10 * 60_000 }, outDir);
	done++;
	console.log(`${new Date().toISOString().slice(11, 19)} ${done}/${todo.length} ${q.id} ${Math.round((r.ms ?? 0) / 1000)}s calls=${r.calls?.length ?? '?'}${r.error ? ' ERROR ' + r.error.slice(0, 120) : ''}${r.timedOut ? ' TIMEOUT' : ''}`);
});
console.log('finished');
process.exit(0);
