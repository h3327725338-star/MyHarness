// node bench-vision.mjs <outDir> <reps>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MH } from './mh.mjs';
import { runTask } from './run-task.mjs';
import { VISION_TASKS } from './tasks-vision.mjs';
const [outDir, reps = '1'] = process.argv.slice(2);
const mh = await MH.fromDevtools(9353);
const rows = [];
for (let rep = 1; rep <= Number(reps); rep++) {
	for (const t of VISION_TASKS) {
		const id = `${t.key}-r${rep}`;
		if (existsSync(join(outDir, `${id}.json`))) continue;
		const data = readFileSync(join('C:/eval/data/vision', t.image)).toString('base64');
		const r = await runTask(mh, { id, prompt: t.prompt, images: [{ mimeType: 'image/png', data }], timeoutMs: 6 * 60_000 }, outDir);
		const pass = t.expect.every((re) => re.test(r.answer || ''));
		rows.push({ id, pass, ms: r.ms });
		console.log(`${id} ${pass ? 'PASS' : 'FAIL'} ${Math.round((r.ms ?? 0) / 1000)}s models=${Object.keys(r.byModel || {}).join(',')} | ${(r.answer || r.error || '').replace(/\s+/g, ' ').slice(0, 200)}`);
	}
}
process.exit(0);
