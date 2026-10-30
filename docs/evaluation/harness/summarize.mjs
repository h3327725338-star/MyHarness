// Collects every run directory into one summary (out/summary.json) and per-item tables (out/*.csv).
// Runs with the main chat on Nemotron 3.5 Lightning live in <name>/, the same runs on Nemotron 3 Ultra in <name>-ultra/.
// node summarize.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSample } from './data.mjs';
import { VISION_TASKS } from './tasks-vision.mjs';

const ROOT = process.env.EVAL_ROOT || 'C:/eval';
const RUNS = join(ROOT, 'runs');
const OUT = join(ROOT, 'out');
mkdirSync(OUT, { recursive: true });
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const jsons = (dir, filter = (f) => f.endsWith('.json')) => (existsSync(dir) ? readdirSync(dir).filter(filter).map((f) => ({ f, ...read(join(dir, f)) })) : []);
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const pct = (xs, p) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };
const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
const costOf = (r) => sum(Object.values(r.byModel || {}).map((m) => m.cost));
const modelsOf = (r) => Object.keys(r.byModel || {}).map((k) => k.replace(/^nebius\/nvidia\//, '')).join(' + ');
const csv = (rows) => { const keys = Object.keys(rows[0] || {}); const esc = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n') + '\n'; };
const summary = {};

// ---------- Web search (SimpleQA sample) ----------
const sample = loadSample().sample;
function searchSystem(dir, questions = sample) {
	const grades = existsSync(join(RUNS, dir, 'grades.json')) ? read(join(RUNS, dir, 'grades.json')) : {};
	const rows = questions.map((q) => {
		const file = join(RUNS, dir, `${q.id}.json`);
		const r = existsSync(file) ? read(file) : null;
		return { q, r, grade: grades[q.id]?.grade ?? null };
	}).filter((x) => x.r && x.grade);
	const n = rows.length;
	const c = rows.filter((x) => x.grade === 'CORRECT').length;
	const i = rows.filter((x) => x.grade === 'INCORRECT').length;
	const na = rows.filter((x) => x.grade === 'NOT_ATTEMPTED').length;
	return { rows, n, correct: c, incorrect: i, notAttempted: na, accuracy: n ? c / n : null, correctGivenAttempted: c + i ? c / (c + i) : null, fScore: n ? (2 * c) / (2 * c + 2 * i + na) : null };
}
/** Which engines' results reached the agent in one chat: every web_search result lists the engines that returned it. */
function enginesSeen(dir, q) {
	const seen = { tavily: 0, bing: 0, google: 0, both: 0, results: 0, pages: 0, failures: {}, benchmarkCopies: 0, openedCopy: false };
	const file = join(RUNS, dir, `${q.id}.jsonl`);
	if (!existsSync(file)) return seen;
	// A copy of the benchmark on the web, the way Brave's write-up filters them: dataset pages and anything named SimpleQA;
	// plus benchmark result files on GitHub, recognised by holding the question's own words.
	const copyName = /huggingface\.co\/datasets|simple[-_ ]?qa|simple-evals/i;
	const words = q.problem.toLowerCase().replace(/\s+/g, ' ').slice(0, 70);
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (line.includes('"toolCall"') && /huggingface\.co\/datasets|simple[-_ ]?qa/i.test(line)) {
			try {
				const calls = JSON.parse(line).message?.content ?? [];
				if (calls.some((c) => c.type === 'toolCall' && copyName.test(JSON.stringify(c.arguments ?? {})))) seen.openedCopy = true;
			} catch {}
		}
		if (!line.includes('"toolName":"web_search"')) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const details = entry.message?.details ?? {};
		seen.pages += (details.pages ?? []).length;
		for (const failure of details.failures ?? []) {
			const key = `${failure.engine ?? 'page'}:${failure.code}`;
			seen.failures[key] = (seen.failures[key] ?? 0) + 1;
		}
		for (const result of details.results ?? []) {
			const engines = result.engines ?? [];
			seen.results++;
			if (engines.includes('tavily')) seen.tavily++;
			if (engines.includes('bing')) seen.bing++;
			if (engines.includes('google')) seen.google++;
			if (engines.length > 1) seen.both++;
			const text = `${result.title ?? ''} ${result.snippet ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
			if (copyName.test(`${result.url ?? ''} ${result.title ?? ''}`) || (/github\.com/i.test(result.url ?? '') && text.includes(words))) seen.benchmarkCopies++;
		}
	}
	return seen;
}
function myharnessSearch(dir, questions = sample) {
	const s = searchSystem(dir, questions);
	const rows = s.rows.map(({ q, r, grade }) => {
		const engines = enginesSeen(dir, q);
		return {
			id: q.id, topic: q.topic, question: q.problem, gold: q.answer, grade, model: modelsOf(r),
			seconds: r.ms ? +(r.ms / 1000).toFixed(1) : null,
			webSearchCalls: (r.calls || []).filter((x) => x.name === 'web_search').length,
			webSearchFailed: (r.calls || []).filter((x) => x.name === 'web_search' && x.isError).length,
			webFetchCalls: (r.calls || []).filter((x) => x.name === 'web_fetch').length,
			toolCalls: (r.calls || []).length,
			toolErrors: (r.calls || []).filter((x) => x.isError).length,
			searchResults: engines.results, tavilyResults: engines.tavily, bingResults: engines.bing, googleResults: engines.google, bothEngines: engines.both,
			pagesRead: engines.pages, benchmarkCopiesInResults: engines.benchmarkCopies, openedBenchmarkCopy: engines.openedCopy, failures: JSON.stringify(engines.failures),
			sourceLink: /https?:\/\//.test(r.answer || ''),
			providerError: r.errorMessage || r.error || '',
			costUsd: +costOf(r).toFixed(5),
			answer: (r.answer || '').replace(/\s+/g, ' ').slice(0, 600),
		};
	});
	if (rows.length) writeFileSync(join(OUT, `${dir.split('/').pop()}.csv`), csv(rows));
	return {
		...Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'rows')),
		medianSeconds: median(rows.map((x) => x.seconds)), p90Seconds: pct(rows.map((x) => x.seconds), 90),
		meanWebSearchCalls: rows.length ? sum(rows.map((x) => x.webSearchCalls)) / rows.length : null,
		webSearchCalls: sum(rows.map((x) => x.webSearchCalls)), webSearchFailed: sum(rows.map((x) => x.webSearchFailed)),
		questionsWithTavilyResults: rows.filter((x) => x.tavilyResults > 0).length, questionsWithBingResults: rows.filter((x) => x.bingResults > 0).length, questionsWithGoogleResults: rows.filter((x) => x.googleResults > 0).length,
		resultsShown: sum(rows.map((x) => x.searchResults)), resultsFromTavily: sum(rows.map((x) => x.tavilyResults)), resultsFromBing: sum(rows.map((x) => x.bingResults)), resultsFromGoogle: sum(rows.map((x) => x.googleResults)), resultsFromBoth: sum(rows.map((x) => x.bothEngines)),
		pagesRead: sum(rows.map((x) => x.pagesRead)),
		failuresReported: rows.reduce((all, x) => { for (const [k, n] of Object.entries(JSON.parse(x.failures))) all[k] = (all[k] ?? 0) + n; return all; }, {}),
		runsWithBenchmarkCopyInResults: rows.filter((x) => x.benchmarkCopiesInResults > 0).map((x) => `${x.id}:${x.grade}`),
		runsThatOpenedABenchmarkCopy: rows.filter((x) => x.openedBenchmarkCopy).map((x) => x.id),
		correctWithoutThoseRuns: rows.filter((x) => x.benchmarkCopiesInResults === 0 && x.grade === 'CORRECT').length,
		runsWithoutThem: rows.filter((x) => x.benchmarkCopiesInResults === 0).length,
		answersWithSourceLink: rows.filter((x) => x.sourceLink).length,
		toolCalls: sum(rows.map((x) => x.toolCalls)), toolErrors: sum(rows.map((x) => x.toolErrors)),
		providerErrors: rows.filter((x) => x.providerError).length,
		meanCostUsd: rows.length ? sum(rows.map((x) => x.costUsd)) / rows.length : null,
		totalCostUsd: sum(rows.map((x) => x.costUsd)),
	};
}
summary.search = {
	sampleSize: sample.length,
	seed: 20261030,
	myharnessLightning: myharnessSearch('search-myharness'),
	myharnessUltra: myharnessSearch('search-myharness-ultra'),
	// Google + Tavily with an API key and 15 pages read per search, with a person at the PC to pass Google's human checks.
	myharnessGoogleTavily: myharnessSearch('search-google-tavily'),
	// The next 100 questions of the same shuffle, none shared with the first sample, on the same settings.
	myharnessGoogleTavilySecondSample: existsSync(join(ROOT, 'data', 'simpleqa-sample-b.json.gz')) ? myharnessSearch('search-google-tavily-b', loadSample(join(ROOT, 'data', 'simpleqa-sample-b.json.gz')).sample) : null,
	// Same model, no tools: what Nemotron 3.5 Lightning knows by itself.
	closedBook: (() => { const s = searchSystem('search-closed'); return { ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'rows')), meanCostUsd: s.rows.length ? sum(s.rows.map((x) => x.r.cost || 0)) / s.rows.length : null }; })(),
	// The first attempt, stopped at 75 questions: Tavily's keyless channel answered HTTP 429 from question 21 on.
	firstAttemptKeylessLimited: myharnessSearch('discarded/search-myharness-tavily-keyless-429'),
};
{
	const s = searchSystem('search-closed');
	if (s.rows.length) writeFileSync(join(OUT, 'search-closed.csv'), csv(s.rows.map(({ q, r, grade }) => ({ id: q.id, question: q.problem, gold: q.answer, grade, answer: (r.answer || '').replace(/\s+/g, ' ').slice(0, 400) }))));
}

// ---------- Memory ----------
const memLabs = ['memory-lab2', 'memory-lab3', 'memory-lab4', 'memory-fixed-lab5', 'memory-fixed-lab6', 'memory-fixed-lab7', 'memory-fixed2-lab8', 'memory-fixed2-lab9', 'memory-fixed2-lab10', 'memory-fixed3-lab11', 'memory-fixed3-lab12', 'memory-fixed3-lab13', 'memory-set2-lab14', 'memory-set2-lab15', 'memory-set2-lab16', 'memory-fixed3-lab17', 'memory-fixed3-lab18', 'memory-fixed3-lab19'].filter((d) => existsSync(join(RUNS, d, 'results.json')));
const memRows = [];
summary.memory = { labs: [] };
for (const d of memLabs) {
	const results = read(join(RUNS, d, 'results.json'));
	const manual = existsSync(join(RUNS, d, 'manual-grades.json')) ? read(join(RUNS, d, 'manual-grades.json')) : {};
	const saved = existsSync(join(RUNS, d, 'memory-after-seed.json')) ? read(join(RUNS, d, 'memory-after-seed.json')) : null;
	// A question is void when the agent read files outside its own test copy: left out of the score, whichever way it came out.
	const graded = results.map((r) => ({ lab: d, ...r, answer: manual[r.id]?.redact ? '(removed: this answer quoted a private document on the test PC)' : r.answer, pass: manual[r.id]?.pass ?? r.autoPass, void: !!manual[r.id]?.void, cause: manual[r.id]?.cause ?? '', note: manual[r.id]?.note ?? '' }));
	memRows.push(...graded);
	const counted = graded.filter((r) => !r.void);
	const by = (kind) => ({ pass: counted.filter((r) => r.kind === kind && r.pass).length, of: counted.filter((r) => r.kind === kind).length });
	summary.memory.labs.push({ lab: d, savedMemories: saved?.memory?.entries?.length ?? null, savedIds: (saved?.memory?.entries ?? []).map((e) => e.id), upkeepSeconds: saved ? Math.round(saved.waitedMs / 1000) : null, direct: by('direct'), applied: by('applied'), unknown: by('unknown'), total: { pass: counted.filter((r) => r.pass).length, of: counted.length }, void: graded.filter((r) => r.void).map((r) => r.id), failed: counted.filter((r) => !r.pass).map((r) => r.id), medianSeconds: median(graded.map((r) => r.ms / 1000)) });
}
if (memRows.length) writeFileSync(join(OUT, 'memory.csv'), csv(memRows.map((r) => ({ lab: r.lab, id: r.id, kind: r.kind, question: r.q, result: r.void ? 'void' : r.pass ? 'pass' : 'fail', cause: r.cause, note: r.note, seconds: +(r.ms / 1000).toFixed(1), answer: (r.answer || '').replace(/\s+/g, ' ').slice(0, 400) }))));

// ---------- Built-in browser on the signed-in portal ----------
const BROWSER_CHECKS = {
	deadlines: (a) => /(30\s*oct|oct(ober)?\s*30)/i.test(a) && /(23[:.]59|11[:.]59\s*pm)/i.test(a) && /(2\s*nov|nov(ember)?\s*2\b)/i.test(a) && /(10[:.]00|10\s*am)/i.test(a) && /(4\s*nov|nov(ember)?\s*4\b)/i.test(a) && /(17[:.]00|5(:00)?\s*pm)/i.test(a),
	'sa-report': (a) => /1,?500/.test(a) && /2,?000/.test(a) && /mei ling/i.test(a) && /arjun/i.test(a) && /daniel/i.test(a) && /risk/i.test(a) && /trade-?off/i.test(a),
	rubric: (a) => /25\s*%/.test(a),
};
function browserRuns(dir) {
	const rows = [];
	for (const r of jsons(join(RUNS, dir), (f) => /^[a-z-]+-r\d+\.json$/.test(f))) {
		const key = r.id.replace(/-r\d+$/, '');
		const portal = existsSync(join(RUNS, dir, `${r.id}.portal.json`)) ? read(join(RUNS, dir, `${r.id}.portal.json`)) : [];
		const pages = portal.filter((p) => !p.p.startsWith('/__') && p.p !== '/favicon.ico');
		rows.push({
			id: r.id, task: key, model: modelsOf(r), pass: !!BROWSER_CHECKS[key]?.(r.answer || ''), seconds: +(r.ms / 1000).toFixed(1),
			toolCalls: (r.calls || []).length, toolErrors: (r.calls || []).filter((c) => c.isError).length,
			stringBooleanErrors: (r.calls || []).filter((c) => c.isError && /must be boolean/.test(c.error || '')).length,
			portalRequests: pages.length, portalRequestsSignedIn: pages.filter((p) => p.signedIn).length,
			downloadedRubric: pages.some((p) => /\/files\/Marking/i.test(decodeURIComponent(p.p))),
			costUsd: +costOf(r).toFixed(5), answer: (r.answer || '').replace(/\s+/g, ' ').slice(0, 500),
		});
	}
	if (rows.length) writeFileSync(join(OUT, `${dir}.csv`), csv(rows));
	const out = {};
	for (const key of Object.keys(BROWSER_CHECKS)) {
		const rs = rows.filter((r) => r.task === key);
		out[key] = { pass: rs.filter((r) => r.pass).length, of: rs.length, medianSeconds: median(rs.map((r) => r.seconds)), toolCalls: sum(rs.map((r) => r.toolCalls)), toolErrors: sum(rs.map((r) => r.toolErrors)), stringBooleanErrors: sum(rs.map((r) => r.stringBooleanErrors)), signedInEveryRequest: rs.every((r) => r.portalRequests === r.portalRequestsSignedIn), downloaded: key === 'rubric' ? rs.filter((r) => r.downloadedRubric).length : undefined };
	}
	return out;
}
summary.browser = { lightning: browserRuns('browser'), ultra: browserRuns('browser-ultra'), lightningFixed: browserRuns('browser-fixed') };

// ---------- Human check handed to the user ----------
function handoffRuns(dir) {
	const hs = jsons(join(RUNS, dir), (f) => f.endsWith('.handoff.json'));
	return { runs: hs.length, handedToUser: hs.filter((h) => h.handoffs?.some((x) => x.reason === 'verify')).length, agentClickedCheck: hs.filter((h) => h.agentClickedCheck).length, finishedCorrectly: hs.filter((h) => h.answerOk).length, medianSeconds: median(hs.map((h) => h.ms / 1000)) };
}
summary.handoff = { lightning: handoffRuns('handoff'), ultra: handoffRuns('handoff-ultra'), lightningFixed: handoffRuns('handoff-fixed') };

// ---------- Vision ----------
const visionRows = [];
for (const r of jsons(join(RUNS, 'vision'), (f) => /-r\d+\.json$/.test(f))) {
	const key = r.id.replace(/-r\d+$/, '');
	const t = VISION_TASKS.find((x) => x.key === key);
	const jsonl = existsSync(join(RUNS, 'vision', `${r.id}.jsonl`)) ? readFileSync(join(RUNS, 'vision', `${r.id}.jsonl`), 'utf8') : '';
	visionRows.push({ id: r.id, task: key, pass: t ? t.expect.every((re) => re.test(r.answer || '')) : false, visionAssistantRan: /"customType":"Vision Assistant"/.test(jsonl), mainModel: modelsOf(r), seconds: +(r.ms / 1000).toFixed(1), answer: (r.answer || '').replace(/\s+/g, ' ').slice(0, 400) });
}
summary.vision = { pass: visionRows.filter((r) => r.pass).length, of: visionRows.length, visionAssistantRan: visionRows.filter((r) => r.visionAssistantRan).length, medianSeconds: median(visionRows.map((r) => r.seconds)), byTask: Object.fromEntries(VISION_TASKS.map((t) => [t.key, { pass: visionRows.filter((r) => r.task === t.key && r.pass).length, of: visionRows.filter((r) => r.task === t.key).length }])) };
if (visionRows.length) writeFileSync(join(OUT, 'vision.csv'), csv(visionRows));

// ---------- Sub-agents ----------
const subRows = [];
for (const r of jsons(join(RUNS, 'subagent'), (f) => /-r\d+\.json$/.test(f))) {
	const kind = r.id.replace(/-r\d+$/, '');
	const a = r.answer || '';
	// The model may start them one call at a time; a call with invalid arguments starts none.
	const agentCalls = (r.calls || []).filter((c) => c.name === 'agent' && !c.isError);
	subRows.push({
		id: r.id, kind, seconds: +(r.ms / 1000).toFixed(1),
		covered: ['first-come|fcfs', 'shortest|sjf', 'round robin|round-robin'].every((p) => new RegExp(p, 'i').test(a)),
		table: /\|.*\|.*\|/.test(a), sourceLinks: new Set(a.match(/https?:\/\/[^\s)\]>|]+/g) || []).size,
		subAgents: agentCalls.reduce((n, c) => n + (Array.isArray(c.args?.tasks) ? c.args.tasks.length : 1), 0),
		toolErrors: (r.calls || []).filter((c) => c.isError).length,
		mainCostUsd: +costOf(r).toFixed(4),
	});
}
summary.subagents = Object.fromEntries(['parallel', 'single'].map((k) => { const rows = subRows.filter((r) => r.kind === k); return [k, { runs: rows.length, complete: rows.filter((r) => r.covered && r.table).length, medianSeconds: median(rows.map((r) => r.seconds)), medianSourceLinks: median(rows.map((r) => r.sourceLinks)), subAgentsPerRun: median(rows.map((r) => r.subAgents)) }]; }));
if (subRows.length) writeFileSync(join(OUT, 'subagents.csv'), csv(subRows));

// ---------- Scheduled tasks ----------
const sched = jsons(join(RUNS, 'schedule'), (f) => f.endsWith('.schedule.json'));
const schedGroup = (rows) => ({ runs: rows.length, created: rows.filter((s) => s.created).length, kinds: rows.map((s) => s.created?.kind ?? null), repeats: rows.map((s) => s.created?.repeat ?? null), firedOnTime: rows.filter((s) => s.run && Math.abs(s.startedLateSec ?? 99) <= 5).length, ranByItself: rows.filter((s) => s.created?.kind === 'agent' && s.run && /done|ok|complete|success/i.test(s.run.status)).length, dueOffsetSeconds: rows.map((s) => s.dueOffsetSec ?? null), startedLateSeconds: rows.map((s) => s.startedLateSec ?? null), answersWithDeadlines: rows.filter((s) => /(30\s*oct|oct(ober)?\s*30)/i.test(s.runAnswer || '') && /(4\s*nov|nov(ember)?\s*4)/i.test(s.runAnswer || '')).length });
// "In 3 minutes, ..." on Lightning; the same request using the word "schedule"; the plain wording with the main chat on Ultra or on DeepSeek V4.1 Flash.
summary.schedules = { plainWords: schedGroup(sched.filter((s) => /^schedule-r\d/.test(s.id))), saysSchedule: schedGroup(sched.filter((s) => /^schedule-explicit-r\d/.test(s.id))), plainWordsUltra: schedGroup(sched.filter((s) => /^schedule-ultra-r\d/.test(s.id))), atClockTime: schedGroup(sched.filter((s) => /^schedule-at-r\d/.test(s.id))), remindMe: schedGroup(sched.filter((s) => /^schedule-remind-r\d/.test(s.id))), everyWeekday: schedGroup(sched.filter((s) => /^schedule-weekdays-r\d/.test(s.id))), plainWordsDeepSeek: schedGroup(sched.filter((s) => /^schedule-flash-r\d/.test(s.id))), atClockTimeDeepSeek: schedGroup(sched.filter((s) => /^schedule-flash-at-r\d/.test(s.id))) };

writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 1));
