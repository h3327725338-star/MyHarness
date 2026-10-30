// Direct calls to Nebius Token Factory (OpenAI-compatible) with the evaluation copy's key, for the baselines and the
// grader. The key is read from the lab's auth.json and never printed.
import { readFileSync } from 'node:fs';
const KEY = JSON.parse(readFileSync('C:/eval/labA/agent/auth.json', 'utf8')).nebius.key;
const BASE = 'https://api.tokenfactory.nebius.com/v1/';
export const PRICES = {
	'nvidia/Nemotron-3_5-Lightning': [0.06, 0.24],
	'nvidia/Nemotron-3-Ultra-550b-a55b': [1, 3],
	'nvidia/Nemotron-3.5-Super-VL': [0.3, 0.9],
};
export async function chat(model, messages, { effort, maxTokens = 8192, retries = 4 } = {}) {
	const body = { model, messages, max_tokens: maxTokens, ...(effort ? { reasoning_effort: effort } : {}) };
	for (let attempt = 0; ; attempt++) {
		const t = Date.now();
		try {
			const r = await fetch(`${BASE}chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
			const text = await r.text();
			if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
			if (!r.ok) return { error: `HTTP ${r.status} ${text.slice(0, 300)}`, ms: Date.now() - t };
			const j = JSON.parse(text);
			const u = j.usage || {};
			const [pi, po] = PRICES[model] || [0, 0];
			return { content: j.choices?.[0]?.message?.content ?? '', usage: u, cost: ((u.prompt_tokens || 0) * pi + (u.completion_tokens || 0) * po) / 1e6, ms: Date.now() - t };
		} catch (error) {
			if (attempt >= retries) return { error: String(error), ms: Date.now() - t };
			await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
		}
	}
}
