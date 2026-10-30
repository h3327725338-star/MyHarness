// A scheduled Agent task asked for in plain words: it must be created for the right time and then run by itself
// (Nemotron 3.5 Lightning does scheduled tasks). node bench-schedule.mjs <outDir> <rep>
import { readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { MH, readSession, sleep, summarize } from './mh.mjs';
import { runTask } from './run-task.mjs';
const [outDir, rep = '1'] = process.argv.slice(2);
const mh = await MH.fromDevtools(9353);
// SCHEDULE_TAG names the variant: "explicit" uses the word "schedule" in the request; EVAL_MODEL=ultra runs the main chat on Ultra.
const tag = process.env.SCHEDULE_TAG ? `${process.env.SCHEDULE_TAG}-` : '';
const id = `schedule-${tag}r${rep}`;
const asked = Date.now();
const before = new Set(((await mh.req('GET', '/api/schedules')).schedules || []).map((t) => t.id));
const WHAT = 'check my course portal and give me a short summary of the deadlines due in the next 7 days.';
// Other ways people ask: a clock time, a plain reminder, a repeating task (only its creation is checked: it is not due during the test).
const clock = new Date(asked + 3 * 60_000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' });
const PROMPTS = {
	explicit: `Schedule a task for 3 minutes from now: ${WHAT}`,
	at: `At ${clock} today, ${WHAT}`,
	remind: 'Remind me in 3 minutes to submit my Operating Systems assignment.',
	weekdays: `Every weekday at 08:00, ${WHAT}`,
	'flash-at': `At ${clock} today, ${WHAT}`,
};
const prompt = PROMPTS[tag.slice(0, -1)] ?? `In 3 minutes, ${WHAT}`;
const repeating = tag === 'weekdays-';
const r = await runTask(mh, { id, prompt, timeoutMs: 6 * 60_000 }, outDir);
const created = ((await mh.req('GET', '/api/schedules')).schedules || []).filter((t) => !before.has(t.id));
const task = created[0];
const record = { id, askedAt: new Date(asked).toISOString(), createMs: r.ms, created: task ?? null, createdCount: created.length };
if (task?.repeat?.at) record.dueOffsetSec = Math.round((Date.parse(task.repeat.at) - asked) / 1000);
// Wait for it to run by itself and finish.
for (let i = 0; i < 90 && task && !repeating; i++) {
	const now = ((await mh.req('GET', '/api/schedules')).schedules || []).find((t) => t.id === task.id);
	// A reminder has no Agent chat, so it never gets an end time.
	if (now?.lastRun?.endedAt || (now?.kind === 'reminder' && now?.lastRun) || /fail|error|missed/i.test(now?.lastRun?.status ?? '')) { record.run = now.lastRun; break; }
	await sleep(10_000);
}
if (record.run) {
	record.startedLateSec = Math.round((Date.parse(record.run.at) - Date.parse(record.run.due)) / 1000);
	// The chat the task ran in.
	const files = [];
	const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const p = join(d, n.name); if (n.isDirectory()) walk(p); else if (n.name.endsWith('.jsonl') && n.name.includes(record.run.sessionId ?? '#')) files.push(p); } };
	walk('C:/eval/labA/data/workspaces');
	if (files[0]) {
		const s = summarize(readSession(files[0]));
		record.runAnswer = s.answer;
		record.runCalls = s.calls.map((c) => c.name + (c.isError ? '!' : ''));
		record.runByModel = s.byModel;
		copyFileSync(files[0], join(outDir, `${id}.run.jsonl`));
	}
}
writeFileSync(join(outDir, `${id}.schedule.json`), JSON.stringify(record, null, 2));
console.log(JSON.stringify({ id, created: !!task, kind: task?.kind, repeat: task?.repeat, dueOffsetSec: record.dueOffsetSec, run: record.run, startedLateSec: record.startedLateSec, calls: record.runCalls, answer: (record.runAnswer || '').replace(/\s+/g, ' ').slice(0, 300) }, null, 1));
process.exit(0);
