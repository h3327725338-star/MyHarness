// Sub-agents (Nemotron 3 Ultra) researching in parallel vs. the main chat doing the same research alone.
// node bench-subagent.mjs <outDir> <reps> [kinds...]
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MH } from './mh.mjs';
import { runTask } from './run-task.mjs';
const [outDir, reps = '1', ...kinds] = process.argv.slice(2);
const TASK = 'I have an exam on CPU scheduling. For each of First-Come-First-Served, Shortest-Job-First and Round Robin: search the web for one reliable source, explain how the algorithm works, give its main pros and cons, and work through a tiny example with the average waiting time. Then combine everything into one comparison table, with the sources.';
export const SUB_TASKS = {
	parallel: `${TASK}\n\nUse three sub-agents working in parallel, one per algorithm.`,
	single: `${TASK}\n\nDo it yourself in this chat; do not use sub-agents.`,
};
const mh = await MH.fromDevtools(9353);
for (let rep = 1; rep <= Number(reps); rep++) {
	for (const kind of Object.keys(SUB_TASKS).filter((k) => !kinds.length || kinds.includes(k))) {
		const id = `${kind}-r${rep}`;
		if (existsSync(join(outDir, `${id}.json`))) continue;
		const r = await runTask(mh, { id, prompt: SUB_TASKS[kind], timeoutMs: 20 * 60_000 }, outDir);
		const a = r.answer || '';
		const covered = ['first-come|fcfs', 'shortest|sjf', 'round robin|round-robin'].every((p) => new RegExp(p, 'i').test(a));
		const table = /\|.*\|.*\|/.test(a);
		const sources = (a.match(/https?:\/\/[^\s)\]>]+/g) || []).length;
		const agentCalls = (r.calls || []).filter((c) => c.name === 'agent');
		console.log(`${id} ${Math.round((r.ms ?? 0) / 1000)}s covered=${covered} table=${table} sourceLinks=${sources} agentCalls=${agentCalls.length} errors=${(r.calls || []).filter((c) => c.isError).length} models=${JSON.stringify(r.byModel)}`);
	}
}
process.exit(0);
