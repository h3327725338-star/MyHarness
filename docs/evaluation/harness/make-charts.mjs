// Draws the write-up's charts from out/summary.json. node make-charts.mjs <chartsDir>
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hbar } from './charts.mjs';
const ROOT = process.env.EVAL_ROOT || 'C:/eval';
const s = JSON.parse(readFileSync(join(ROOT, 'out', 'summary.json'), 'utf8'));
const dir = process.argv[2] || join(ROOT, 'out', 'charts');
mkdirSync(dir, { recursive: true });
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const ticks = { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], tickFormat: (t) => `${t * 100}%` };

const first = s.search.myharnessGoogleTavily, second = s.search.myharnessGoogleTavilySecondSample, light = s.search.myharnessLightning, closed = s.search.closedBook;
const searchRows = [
	{ group: 'This evaluation: Nemotron 3.5 Lightning, random SimpleQA samples', label: 'Google + Tavily key, first 100', value: first.accuracy, text: `${first.correct} / ${first.n}`, cls: 'hi' },
	{ label: 'Google + Tavily key, second 100', value: second.accuracy, text: `${second.correct} / ${second.n}`, cls: 'hi' },
	{ label: 'Bing + keyless Tavily, no setup', value: light.accuracy, text: `${light.correct} / ${light.n}`, cls: 'hi' },
	{ label: 'Same model, no search', value: closed.accuracy, text: `${closed.correct} / ${closed.n}`, cls: 'mute' },
	{ group: "Vendors' published numbers: other dates and samples, not head-to-head", label: 'Parallel + GPT-5.6 (SimpleQA Verified)', value: 0.97, text: '97%', cls: 'ref' },
	{ label: 'Tavily + GPT-4.1', value: 0.933, text: '93.3%', cls: 'ref' },
	{ label: 'Brave AI Grounding, research', value: 0.9325, text: '93.25%', cls: 'ref' },
	{ label: 'GPT-4o search preview (OpenAI)', value: 0.9, text: '90%', cls: 'ref' },
	{ label: 'GPT-4o, no search (OpenAI)', value: 0.38, text: '38%', cls: 'ref' },
];
hbar(join(dir, 'search-accuracy.svg'), searchRows, { title: 'Short fact questions answered correctly (SimpleQA)', subtitle: "Graded with OpenAI's own SimpleQA grader prompt", ...ticks, labelWidth: 290, width: 800 });

const wf = [];
const add = (group, label, pass, of, cls = 'hi') => { if (of) wf.push({ group, label, value: pass / of, text: `${pass} / ${of}`, cls }); };
add('Nemotron 3.5 Super VL (Vision Assistant)', 'Reading charts, receipts, screenshots', s.vision.pass, s.vision.of);
const browser = s.browser.lightningFixed;
add('Signed-in website (Nemotron 3.5 Lightning)', 'Deadlines from the portal', browser.deadlines.pass, browser.deadlines.of);
add('Signed-in website (Nemotron 3.5 Lightning)', 'Group report details from a course page', browser['sa-report'].pass, browser['sa-report'].of);
add('Signed-in website (Nemotron 3.5 Lightning)', 'Download a PDF and read a value', browser.rubric.pass, browser.rubric.of);
add('Handing a human check to a real person', 'Handed over, then finished the task', s.handoff.lightningFixed.finishedCorrectly, s.handoff.lightningFixed.runs);
const sched = s.schedules;
add('Scheduled tasks', '"Remind me in 3 minutes..."', sched.remindMe.firedOnTime, sched.remindMe.runs);
add('Scheduled tasks', '"Schedule a task...": ran and did the job', sched.saysSchedule.ranByItself, sched.saysSchedule.runs);
add('Scheduled tasks', '"Every weekday at 08:00...": agent task set', sched.everyWeekday.kinds.filter((k) => k === 'agent').length, sched.everyWeekday.runs);
add('Scheduled tasks', '"In 3 minutes, do X" on DeepSeek V4.1 Flash', sched.plainWordsDeepSeek.created + sched.atClockTimeDeepSeek.created, sched.plainWordsDeepSeek.runs + sched.atClockTimeDeepSeek.runs);
add('Sub-agents (Nemotron 3 Ultra)', 'Complete report from parallel sub-agents', s.subagents.parallel.complete, s.subagents.parallel.runs);
const memory = (prefix) => s.memory.labs.filter((l) => l.lab.startsWith(prefix));
const sumBy = (labs, k) => labs.reduce((a, l) => ({ pass: a.pass + l[k].pass, of: a.of + l[k].of }), { pass: 0, of: 0 });
const set1 = memory('memory-fixed3-lab1').filter((l) => /lab1[789]$/.test(l.lab)), set2 = memory('memory-set2');
const memGroup = 'Memory in new chats (Nemotron 3.5 Lightning)';
add(memGroup, 'Student A, 3 runs, all questions', sumBy(set1, 'total').pass, sumBy(set1, 'total').of);
add(memGroup, 'Student B (facts never tuned on), 3 runs', sumBy(set2, 'total').pass, sumBy(set2, 'total').of);
add(memGroup, 'Said "I don\'t know" when never told', sumBy([...set1, ...set2], 'unknown').pass, sumBy([...set1, ...set2], 'unknown').of);
hbar(join(dir, 'workflows.svg'), wf, { title: 'Core workflows: runs that gave the right result', subtitle: 'Each run in a new chat', ...ticks, labelWidth: 320, width: 800 });
console.log('charts in', dir, pct(first.accuracy ?? 0));
