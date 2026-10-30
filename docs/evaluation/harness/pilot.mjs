import { MH } from './mh.mjs';
import { runTask } from './run-task.mjs';
const mh = await MH.fromDevtools(9353);
const [id, ...words] = process.argv.slice(2);
const r = await runTask(mh, { id, prompt: words.join(' ') }, 'C:/eval/runs/pilot');
console.log(JSON.stringify({ ms: r.ms, timedOut: r.timedOut, error: r.error, stop: r.stopReason, err: r.errorMessage, calls: r.calls?.map(c => `${c.name}${c.isError ? '(ERR ' + c.error + ')' : ''}`), byModel: r.byModel, answer: r.answer?.slice(0, 700) }, null, 1));
process.exit(0);
