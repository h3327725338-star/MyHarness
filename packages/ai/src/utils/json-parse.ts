import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Strict output-side tool-argument parsing (P2-4).
 *
 * Preview deltas may use {@link parseStreamingJson} (partial-json guessing) for UI only.
 * Execution must only use this function at complete call end: plain `JSON.parse`
 * plus the deterministic {@link repairJson} (raw control characters / invalid
 * escapes). It never guesses missing values or fields and never completes a
 * truncated string or container. Empty input yields `{}` for parameterless tools;
 * anything else that does not parse deterministically throws so the caller can
 * refuse execution instead of running guessed arguments.
 */
export function parseCompleteToolArguments(raw: string | undefined): Record<string, unknown> {
	if (raw === undefined || raw.trim() === "") {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const repaired = repairJson(raw);
		if (repaired === raw) {
			throw error;
		}
		parsed = JSON.parse(repaired);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Tool arguments are not a JSON object");
	}
	return parsed as Record<string, unknown>;
}

export type CompleteToolArgumentsResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

export function tryParseCompleteToolArguments(raw: string | undefined): CompleteToolArgumentsResult {
	try {
		return { ok: true, value: parseCompleteToolArguments(raw) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Finalize accumulated streaming tool JSON at complete call end.
 * On success returns parsed arguments; on failure returns `{}` plus a
 * non-empty `parseError` so the host refuses execution and asks the model to
 * re-issue the call with complete arguments. Never returns guessed partial values.
 */
export function finalizeToolCallArguments(raw: string | undefined): {
	args: Record<string, unknown>;
	parseError?: string;
} {
	const result = tryParseCompleteToolArguments(raw);
	if (result.ok) {
		return { args: result.value };
	}
	return { args: {}, parseError: result.error };
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 * Preview-only: never use its result for execution. Final tool arguments must
 * go through {@link parseCompleteToolArguments} / {@link finalizeToolCallArguments}.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
