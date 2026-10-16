/** Lightweight JSON argument precheck (P2-10). Zero deps: plain schema read, no TypeBox/AJV. Fail-fast before full validation; returns error string (no throw) so caller emits immediate error result for model re-issue. */

interface PrecheckSchema {
	type?: string | string[];
	properties?: Record<string, PrecheckSchema>;
	required?: string[];
	enum?: unknown[];
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number | boolean;
	exclusiveMaximum?: number | boolean;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	items?: PrecheckSchema;
}

/**
 * Separator between the failure a reader may see and the block that follows it.
 *
 * Everything after this heading is written for the model that authored the call
 * (which field shape to fix, and how). No surface that shows a tool result to a
 * person may render it: cut the text with {@link stripModelGuidance} before display.
 */
export const MODEL_GUIDANCE_HEADING = "\n\n[re-issue guidance for the model]\n";

/** Drops the model-only guidance block from tool output that a human is about to read. */
export function stripModelGuidance(text: string): string {
	const index = text.indexOf(MODEL_GUIDANCE_HEADING);
	return index === -1 ? text : text.slice(0, index);
}

function jsonTypeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (Number.isInteger(value)) return "integer";
	return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
	if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
	if (expected === "number") return typeof value === "number" && Number.isFinite(value);
	return jsonTypeOf(value) === expected;
}

const PREVIEW_CHARS = 160;

/** The offending value as one escaped line, so control characters cannot forge a second message. */
function previewOf(value: string): string {
	const clipped = value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value;
	return JSON.stringify(clipped);
}

type PrecheckFailure = { message: string; guidance: string[] };

/**
 * A container the schema declares arrived as a string. Name which of the three real
 * causes it is (plain text, a valid container that was quoted, or malformed JSON)
 * instead of reporting a bare type mismatch, which reads as "this shape is unsupported".
 */
function containerSentAsString(value: string, expected: string[], path: string): PrecheckFailure {
	const trimmed = value.trim();
	const where = `\`${path || "the arguments"}\``;
	const base = `${path}: expected type ${expected.join("/")} but received a string (${value.length} chars)`;
	if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) {
		return {
			message: `${base} of plain text. Preview: ${previewOf(value)}`,
			guidance: [
				`Write ${where} as a real ${expected.join(" or ")} value, not as text.`,
				"Nested arrays and objects are JSON containers inside the argument object; quoting them turns them into a string.",
			],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		return {
			message: `${base} that looks like JSON but does not parse (${error instanceof Error ? error.message : String(error)}). Preview: ${previewOf(value)}`,
			guidance: [
				`The JSON under ${where} is malformed; the parse message above names the offset. Fix the syntax there and keep the rest of the call unchanged.`,
				`Quotes inside long text fields are the usual cause of broken JSON under ${where}: remove them or use 「」 so the surrounding JSON stays valid.`,
				"Split an oversized argument block into several smaller calls instead of one long one.",
			],
		};
	}
	return {
		message: `${base} holding valid JSON of type ${jsonTypeOf(parsed)}. Preview: ${previewOf(value)}`,
		guidance: [
			`${where} was serialized as a string. Emit it unquoted so it arrives as ${jsonTypeOf(parsed)}.`,
			"Only the reported path is wrong: re-issue the same call with that one field fixed.",
		],
	};
}

function checkValue(value: unknown, schema: PrecheckSchema, path: string): PrecheckFailure | null {
	const label = `\`${path || "the arguments"}\``;
	if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === value)) {
		return {
			message: `${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`,
			guidance: [
				`Use one of the allowed values for ${label}: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}.`,
			],
		};
	}
	const types = typeof schema.type === "string" ? [schema.type] : (schema.type ?? []);
	if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
		if (typeof value === "string" && (types.includes("array") || types.includes("object"))) {
			return containerSentAsString(value, types, path);
		}
		return {
			message: `${path}: expected type ${types.join("/")} but got ${jsonTypeOf(value)}`,
			guidance: [`Write ${label} as ${types.join(" or ")}, given ${jsonTypeOf(value)}.`],
		};
	}
	if (typeof value === "number") {
		const exMin = typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined;
		const exMax = typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined;
		if (schema.minimum !== undefined && value < schema.minimum)
			return {
				message: `${path}: ${value} < minimum ${schema.minimum}`,
				guidance: [`${label} must be at least ${schema.minimum}.`],
			};
		if (schema.maximum !== undefined && value > schema.maximum)
			return {
				message: `${path}: ${value} > maximum ${schema.maximum}`,
				guidance: [`${label} must be at most ${schema.maximum}.`],
			};
		if (exMin !== undefined && value <= exMin)
			return {
				message: `${path}: ${value} <= exclusiveMinimum ${exMin}`,
				guidance: [`${label} must be greater than ${exMin}.`],
			};
		if (exMax !== undefined && value >= exMax)
			return {
				message: `${path}: ${value} >= exclusiveMaximum ${exMax}`,
				guidance: [`${label} must be less than ${exMax}.`],
			};
		return null;
	}
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength)
			return {
				message: `${path}: shorter than minLength ${schema.minLength}`,
				guidance: [`${label} needs at least ${schema.minLength} characters (got ${value.length}).`],
			};
		if (schema.maxLength !== undefined && value.length > schema.maxLength)
			return {
				message: `${path}: longer than maxLength ${schema.maxLength}`,
				guidance: [
					`${label} is limited to ${schema.maxLength} characters (got ${value.length}); shorten it or split the call.`,
				],
			};
		return null;
	}
	if (Array.isArray(value)) {
		const bounds = `${schema.minItems !== undefined ? `${schema.minItems} or more` : ""}${
			schema.minItems !== undefined && schema.maxItems !== undefined ? " and " : ""
		}${schema.maxItems !== undefined ? `at most ${schema.maxItems}` : ""}`;
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			return {
				message: `${path}: fewer than minItems ${schema.minItems}`,
				guidance: [
					`${label} must carry ${bounds} items (got ${value.length}).`,
					`The item count is the failure: add the missing item(s) to ${label} instead of rewriting the ones already there.`,
				],
			};
		}
		if (schema.maxItems !== undefined && value.length > schema.maxItems) {
			return {
				message: `${path}: more than maxItems ${schema.maxItems}`,
				guidance: [
					`${label} accepts ${bounds} items (got ${value.length}); split the remainder into a second call.`,
				],
			};
		}
		if (schema.items) {
			for (let i = 0; i < value.length; i++) {
				const err = checkValue(value[i], schema.items, `${path}[${i}]`);
				if (err) return err;
			}
		}
		return null;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in record)) {
				return {
					message: `${path ? `${path}.` : ""}${key}: missing required field`,
					guidance: [`Add the required field \`${key}\` to ${label}.`],
				};
			}
		}
		if (!schema.properties) return null;
		for (const [key, sub] of Object.entries(schema.properties)) {
			if (!(key in record)) continue;
			const err = checkValue(record[key], sub, path ? `${path}.${key}` : key);
			if (err) return err;
		}
	}
	return null;
}

/**
 * Precheck tool arguments against the tool's JSON schema.
 * @returns null when the args pass the light checks; otherwise a reason naming the
 * offending/missing field and what really happened to it (caller turns it into a
 * re-issuable error result), followed by a model-only guidance block after
 * {@link MODEL_GUIDANCE_HEADING}.
 */
export function precheckToolArguments(
	tool: { name: string; parameters?: unknown },
	toolCall: { name: string; arguments?: unknown },
): string | null {
	const args = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return (
			`arguments: expected an object for tool "${tool.name}"` +
			`${MODEL_GUIDANCE_HEADING}- Send one JSON object whose fields are the tool's parameters.`
		);
	}
	const schema = tool.parameters as PrecheckSchema | undefined;
	if (!schema || typeof schema !== "object") return null;
	try {
		const failure = checkValue(args, schema, "");
		if (!failure) return null;
		const guidance = failure.guidance.filter((line, index) => failure.guidance.indexOf(line) === index);
		return (
			`Invalid arguments for tool "${toolCall.name}": ${failure.message}. Re-issue the tool call with complete arguments.` +
			`${MODEL_GUIDANCE_HEADING}${guidance.map((line) => `- ${line}`).join("\n")}`
		);
	} catch {
		return null;
	}
}
