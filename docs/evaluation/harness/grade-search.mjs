// Grades every recorded answer with OpenAI's SimpleQA grader template (verbatim from openai/simple-evals), run on
// Nemotron 3 Ultra. Writes <runDir>/grades.json: { id: { grade: CORRECT|INCORRECT|NOT_ATTEMPTED, raw } }.
// node grade-search.mjs <sample.json> <runDir> [concurrency]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSample } from './data.mjs';
import { pool } from './mh.mjs';
import { chat } from './nebius.mjs';
const [sampleFile, runDir, concurrency = '6'] = process.argv.slice(2);
const { sample } = loadSample(sampleFile);
const template = readFileSync('C:/eval/data/simpleqa-grader-template.txt', 'utf8');
const gradesFile = join(runDir, 'grades.json');
const grades = existsSync(gradesFile) ? JSON.parse(readFileSync(gradesFile, 'utf8')) : {};
const NAMES = { A: 'CORRECT', B: 'INCORRECT', C: 'NOT_ATTEMPTED' };
let cost = 0;
await pool(sample, Number(concurrency), async (q) => {
	if (grades[q.id]?.grade) return;
	const file = join(runDir, `${q.id}.json`);
	if (!existsSync(file)) return;
	const rec = JSON.parse(readFileSync(file, 'utf8'));
	const predicted = (rec.answer || '').trim();
	if (!predicted) { grades[q.id] = { grade: 'NOT_ATTEMPTED', raw: '(no answer)', empty: true }; return; }
	const prompt = template.replace('{question}', q.problem).replace('{target}', q.answer).replace('{predicted_answer}', predicted);
	const r = await chat('nvidia/Nemotron-3-Ultra-550b-a55b', [{ role: 'user', content: prompt }], { effort: 'medium', maxTokens: 4096 });
	cost += r.cost || 0;
	const letter = (r.content || '').trim().match(/\b([ABC])\b/)?.[1];
	grades[q.id] = { grade: letter ? NAMES[letter] : 'UNPARSED', raw: (r.content || r.error || '').slice(0, 200) };
});
writeFileSync(gradesFile, `${JSON.stringify(grades, null, 2)}\n`);
const counts = {};
for (const g of Object.values(grades)) counts[g.grade] = (counts[g.grade] || 0) + 1;
const n = Object.keys(grades).length;
const correct = counts.CORRECT || 0, attempted = n - (counts.NOT_ATTEMPTED || 0);
const ca = attempted ? correct / attempted : 0, co = n ? correct / n : 0;
console.log(JSON.stringify({ n, counts, correctOverall: co, correctGivenAttempted: ca, f1: ca + co ? (2 * ca * co) / (ca + co) : 0, graderCost: cost }));
