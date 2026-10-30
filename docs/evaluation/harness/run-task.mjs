// Runs one evaluation task in a fresh chat of a MyHarness copy and records what happened.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLASH, LIGHTNING, readSession, sleep, summarize, ULTRA } from './mh.mjs';

// The main chat's model: the task's own, else EVAL_MODEL=ultra for Nemotron 3 Ultra or EVAL_MODEL=flash for DeepSeek V4.1
// Flash (the shipped default), else Nemotron 3.5 Lightning.
const defaultModel = () => (process.env.EVAL_MODEL === 'ultra' ? ULTRA : process.env.EVAL_MODEL === 'flash' ? FLASH : LIGHTNING);

/**
 * task: { id, prompt, model?, images?, timeoutMs?, followUps?: string[] }
 * Saves <outDir>/<id>.json and a copy of the chat's JSONL next to it.
 */
export async function runTask(mh, task, outDir) {
	mkdirSync(outDir, { recursive: true });
	const record = { id: task.id, prompt: task.prompt, startedAt: new Date().toISOString() };
	try {
		record.model = task.model ?? defaultModel();
		// Two tasks that ask for a new chat in the same instant can be handed the same blank one, and the second is then
		// refused the model switch with 409 (four of 637 runs before this retry). That says nothing about the task: ask again.
		let slot;
		for (let attempt = 0; ; attempt++) {
			slot = await mh.newChat();
			try {
				await mh.setModel(slot, record.model);
				break;
			} catch (error) {
				if (attempt >= 5 || !/-> 409 /.test(String(error))) throw error;
				await sleep(2000);
			}
		}
		record.slot = slot;
		const turns = [task.prompt, ...(task.followUps ?? [])];
		record.turns = [];
		const t0 = Date.now();
		for (let i = 0; i < turns.length; i++) {
			const t = Date.now();
			await mh.prompt(slot, turns[i], i === 0 ? task.images : undefined);
			await sleep(800);
			const done = await mh.waitDone(slot, { timeoutMs: task.timeoutMs ?? 12 * 60_000 });
			record.turns.push({ ms: Date.now() - t, timedOut: done.timedOut });
			record.sessionFile = done.state?.session?.file ?? record.sessionFile;
			if (done.timedOut) break;
		}
		record.ms = Date.now() - t0;
		record.timedOut = record.turns.some((x) => x.timedOut);
		const entries = readSession(record.sessionFile);
		Object.assign(record, summarize(entries));
		if (record.sessionFile) copyFileSync(record.sessionFile, join(outDir, `${task.id}.jsonl`));
	} catch (error) {
		record.error = String(error?.stack || error);
	}
	record.finishedAt = new Date().toISOString();
	writeFileSync(join(outDir, `${task.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
	return record;
}
