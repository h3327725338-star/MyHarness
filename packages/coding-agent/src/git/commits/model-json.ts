import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";

/** First line of the error when the model's answer is not JSON; the web UI translates it and shows the rest as details. */
export const INVALID_MODEL_JSON =
	"The model returned a commit description that is not valid JSON, so no commit was created. Try again.";

/** One tool-free model request `(systemPrompt, input) => answer`, the shape every Git helper request uses. */
export type ModelCompletion = (systemPrompt: string, input: string) => Promise<string>;

const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * Undo the mistakes models make most often when they hand-write JSON, without guessing at structure: a Markdown fence
 * or a sentence around the object, an escape JSON does not have (`\<`), and raw line breaks or tabs inside a string.
 * Anything else is left for the parser to reject.
 */
export function normalizeModelJson(text: string): string {
	let value = text.trim();
	const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/u.exec(value);
	if (fenced) value = fenced[1].trim();
	const start = value.search(/[{[]/u);
	const end = Math.max(value.lastIndexOf("}"), value.lastIndexOf("]"));
	if (start >= 0 && end > start) value = value.slice(start, end + 1);
	let out = "";
	let inString = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (!inString) {
			if (character === '"') inString = true;
			out += character;
			continue;
		}
		if (character === "\\") {
			const next = value[index + 1];
			if (next !== undefined && VALID_ESCAPES.has(next)) {
				// \u must be followed by four hex digits to be an escape at all.
				if (next !== "u" || /^[0-9a-fA-F]{4}$/u.test(value.slice(index + 2, index + 6))) {
					out += character + next;
					index++;
					continue;
				}
			}
			// A backslash JSON does not know as an escape: the character after it was meant literally.
			continue;
		}
		if (character === '"') inString = false;
		if (character === "\n") out += "\\n";
		else if (character === "\r") out += "\\r";
		else if (character === "\t") out += "\\t";
		else out += character;
	}
	return out;
}

/** The answer around the parser's error position (it is often far past the start of a long answer). */
function excerptAround(text: string, reason: string): string {
	const head = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
	const position = /position (\d+)/u.exec(reason);
	if (!position || text.length <= 1200) return head;
	const at = Number(position[1]);
	if (at < 1000) return head;
	const from = Math.max(0, at - 400);
	return `${head}\n…\nAround position ${at}:\n${from > 0 ? "…" : ""}${text.slice(from, at + 400)}${at + 400 < text.length ? "…" : ""}`;
}

/** Parse one answer of the model, after `normalizeModelJson`. Throws with the parser's reason and the answer. */
export function parseModelJson(text: string): unknown {
	try {
		return JSON.parse(normalizeModelJson(text));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ModelJsonError(reason, text);
	}
}

export class ModelJsonError extends Error {
	readonly reason: string;
	readonly answer: string;

	constructor(reason: string, answer: string) {
		super(`${INVALID_MODEL_JSON}
${reason}
Model output:
${excerptAround(answer, reason)}`);
		this.reason = reason;
		this.answer = answer;
	}
}

/**
 * Parse an answer; when it is still not JSON after normalization, ask the model once to return the same content as
 * valid JSON, then parse that. A second malformed answer throws `ModelJsonError` for the first answer, whose text the
 * details show.
 */
export async function parseModelJsonWithRepair(
	text: string,
	complete: ModelCompletion,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		return parseModelJson(text);
	} catch (error) {
		if (!(error instanceof ModelJsonError)) throw error;
		const prompt = loadSystemPrompt("tasks/json-repair.md");
		if (!prompt.trim()) throw error;
		signal?.throwIfAborted();
		const repaired = await complete(prompt, JSON.stringify({ parserError: error.reason, answer: text }));
		signal?.throwIfAborted();
		try {
			return parseModelJson(repaired);
		} catch {
			throw error;
		}
	}
}
