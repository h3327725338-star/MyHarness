// node bench-browser.mjs <outDir> <reps> [keys...]
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MH } from './mh.mjs';
import { runTask } from './run-task.mjs';
import { BROWSER_TASKS } from './tasks-browser.mjs';
const [outDir, reps = '1', ...keys] = process.argv.slice(2);
const mh = await MH.fromDevtools(9353);
for (let rep = 1; rep <= Number(reps); rep++) {
	for (const task of BROWSER_TASKS.filter((t) => !keys.length || keys.includes(t.key))) {
		const id = `${task.key}-r${rep}`;
		if (existsSync(join(outDir, `${id}.json`))) continue;
		const portalBefore = await (await fetch('http://127.0.0.1:47823/__log')).json();
		const r = await runTask(mh, { id, prompt: task.prompt, timeoutMs: 10 * 60_000 }, outDir);
		const portal = await (await fetch('http://127.0.0.1:47823/__log')).json();
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(outDir, `${id}.portal.json`), JSON.stringify(portal, null, 1));
		console.log(`${new Date().toISOString().slice(11, 19)} ${id} ${Math.round((r.ms ?? 0) / 1000)}s calls=${r.calls?.map((c) => c.name + (c.isError ? '!' : '')).join(',')} portalHits=${portal.length} signedIn=${portal.filter((p) => p.signedIn).length}${r.error ? ' ERROR ' + r.error.slice(0, 200) : ''}`);
		console.log('   ', (r.answer || '').replace(/\s+/g, ' ').slice(0, 400));
	}
}
process.exit(0);
