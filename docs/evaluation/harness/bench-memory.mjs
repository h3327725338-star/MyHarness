// node bench-memory.mjs <port> <outDir> [concurrency]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIGHTNING, MH, pool, readSession, sleep, summarize } from './mh.mjs';
import { runTask } from './run-task.mjs';
import { autoGrade, QUESTIONS as QUESTIONS_1, QUESTIONS_2, SEED as SEED_1, SEED_2 } from './tasks-memory.mjs';
const [port, outDir, concurrency = '2'] = process.argv.slice(2);
const SEED = process.env.MEMORY_SET === '2' ? SEED_2 : SEED_1;
const QUESTIONS = process.env.MEMORY_SET === '2' ? QUESTIONS_2 : QUESTIONS_1;
mkdirSync(outDir, { recursive: true });
const mh = new MH(`http://127.0.0.1:${port}`);
// 1. One chat where the user tells the facts, turn by turn (as anyone introduces themselves).
const seed = await runTask(mh, { id: 'seed', prompt: SEED[0], followUps: SEED.slice(1), timeoutMs: 8 * 60_000 }, outDir);
console.log(`seed done ${Math.round(seed.ms / 1000)}s`);
// 2. Wait for the background memory upkeep (Nemotron 3.5 Lightning) to finish: idle for 10 s in a row, at least 20 s
//    after the last seed message (the upkeep starts a moment after each answer).
const t0 = Date.now();
let lastMem = null;
let idleSince = 0;
for (let i = 0; i < 300; i++) {
	const st = await mh.state(seed.slot).catch(() => null);
	const phase = st?.memoryMaintenance?.phase ?? 'unknown';
	lastMem = { phase };
	if (phase === 'idle') { if (!idleSince) idleSince = Date.now(); } else idleSince = 0;
	if (idleSince && Date.now() - idleSince > 10_000 && Date.now() - t0 > 20_000) break;
	await sleep(1000);
}
// With 5 or more changes the upkeep also writes the resident profile, a moment after the extraction; wait for that too.
const readMemory = () => mh.req('GET', '/api/memory?scope=global', undefined, seed.slot).catch((e) => ({ error: String(e) }));
for (let i = 0; i < 360; i++) {
	const entries = (await readMemory()).entries ?? [];
	if (entries.length < 5 || entries.some((e) => /用户画像/.test(e.id))) break;
	await sleep(1000);
}
const memory = await readMemory();
writeFileSync(join(outDir, 'memory-after-seed.json'), JSON.stringify({ waitedMs: Date.now() - t0, lastMem, memory }, null, 1));
console.log(`memory written: ${memory.entries?.length ?? 0} global entries after ${Math.round((Date.now() - t0) / 1000)}s`);
// 3. Every question in its own new chat.
const results = await pool(QUESTIONS, Number(concurrency), async (q) => {
	const r = await runTask(mh, { id: q.id, prompt: q.q, timeoutMs: 6 * 60_000 }, outDir);
	const pass = autoGrade(q, r.answer);
	console.log(`${q.id} ${q.kind} ${pass ? 'PASS' : 'FAIL'} ${Math.round((r.ms ?? 0) / 1000)}s | ${(r.answer || r.error || '').replace(/\s+/g, ' ').slice(0, 160)}`);
	return { id: q.id, kind: q.kind, q: q.q, answer: r.answer, autoPass: pass, ms: r.ms, calls: r.calls?.map((c) => c.name) };
});
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 1));
console.log('finished', results.filter((r) => r.autoPass).length, '/', results.length);
process.exit(0);
