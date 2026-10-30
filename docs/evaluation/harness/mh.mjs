// A small client for one MyHarness copy's own Web UI API (the same HTTP routes the app page calls), plus helpers that
// read a finished chat back from its session JSONL. Used by every evaluation script.
import { existsSync, readFileSync } from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const LIGHTNING = { provider: 'nebius', id: 'nvidia/Nemotron-3_5-Lightning', thinkingLevel: 'high' };
export const ULTRA = { provider: 'nebius', id: 'nvidia/Nemotron-3-Ultra-550b-a55b', thinkingLevel: 'high' };
export const FLASH = { provider: 'nebius', id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', thinkingLevel: 'max' };

export class MH {
	constructor(base) {
		this.base = base;
	}

	/** The desktop copy's server: the app page's address, read from its DevTools list. */
	static async fromDevtools(port) {
		for (let i = 0; i < 240; i++) {
			try {
				const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
				const page = list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/(\?.*)?$/.test(t.url) && !/:478\d\d\//.test(t.url));
				if (page) return new MH(new URL(page.url).origin);
			} catch {}
			await sleep(500);
		}
		throw new Error(`no app page on DevTools ${port}`);
	}

	async req(method, path, body, slot) {
		const headers = { 'x-myharness-web': '1' };
		if (body !== undefined) headers['content-type'] = 'application/json';
		if (slot) headers['x-myharness-slot'] = slot;
		const response = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await response.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = text;
		}
		if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 400)}`);
		return json;
	}

	state(slot) {
		return this.req('GET', '/api/state', undefined, slot);
	}

	/** A new chat in its own slot (General mode, MyHarness's default working folder). */
	async newChat(mode = 'general') {
		const { slot } = await this.req('POST', '/api/sessions/new', { mode, unbound: true });
		return slot;
	}

	setModel(slot, model) {
		return this.req('POST', '/api/model', { provider: model.provider, id: model.id, thinkingLevel: model.thinkingLevel }, slot);
	}

	prompt(slot, text, images) {
		return this.req('POST', '/api/prompt', { text, ...(images ? { images } : {}) }, slot);
	}

	/** Waits until the chat's run is over (no stream, compaction, retry or background task). */
	async waitDone(slot, { timeoutMs = 15 * 60_000, onWaiting } = {}) {
		const start = Date.now();
		let seenActive = false;
		let quietSince = 0;
		let last;
		while (Date.now() - start < timeoutMs) {
			try {
				last = await this.state(slot);
			} catch (error) {
				await sleep(1500);
				continue;
			}
			const f = last.flags || {};
			const busy = last.active || f.streaming || f.compacting || f.retrying || (f.background ?? 0) > 0;
			if (busy) {
				seenActive = true;
				quietSince = 0;
			} else if (seenActive || Date.now() - start > 20_000) {
				if (!quietSince) quietSince = Date.now();
				if (Date.now() - quietSince > 2500) return { state: last, timedOut: false, ms: Date.now() - start };
			}
			if (onWaiting && last.dialogs?.length) await onWaiting(last);
			await sleep(1000);
		}
		return { state: last, timedOut: true, ms: Date.now() - start };
	}
}

/** Every entry of a session JSONL. */
export function readSession(file) {
	if (!file || !existsSync(file)) return [];
	const out = [];
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {}
	}
	return out;
}

const textOf = (content) =>
	typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p.type === 'text').map((p) => p.text).join('') : '';

/**
 * What a finished chat did: the last assistant answer, every tool call (with errors), and token/cost totals per model
 * for the main chat (sub-agent work is reported by its tool results and the copy's spend file).
 */
export function summarize(entries) {
	const messages = entries.filter((e) => e.type === 'message' && e.message).map((e) => e.message);
	const calls = [];
	const results = new Map();
	const byModel = {};
	let answer = '';
	for (const m of messages) {
		if (m.role === 'assistant') {
			for (const part of m.content || []) if (part.type === 'toolCall') calls.push({ id: part.id, name: part.name, args: part.arguments });
			const t = textOf(m.content).trim();
			if (t) answer = t;
			const key = `${m.provider}/${m.model}`;
			const u = m.usage || {};
			const row = (byModel[key] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 });
			row.calls++;
			row.input += u.input || 0;
			row.output += u.output || 0;
			row.cacheRead += u.cacheRead || 0;
			row.cost += u.cost?.total || 0;
		}
		if (m.role === 'toolResult') results.set(m.toolCallId, m);
	}
	for (const call of calls) {
		const r = results.get(call.id);
		call.isError = !!r?.isError;
		if (r?.isError) call.error = textOf(r.content).slice(0, 300);
	}
	const last = [...messages].reverse().find((m) => m.role === 'assistant');
	return { answer, calls, byModel, stopReason: last?.stopReason ?? null, errorMessage: last?.errorMessage ?? null, messages: messages.length };
}

/** Runs `worker` over `items` with at most `limit` at once. */
export async function pool(items, limit, worker) {
	const results = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await worker(items[index], index);
			}
		}),
	);
	return results;
}
