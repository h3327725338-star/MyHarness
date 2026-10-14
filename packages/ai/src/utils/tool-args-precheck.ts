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

function checkValue(value: unknown, schema: PrecheckSchema, path: string): string | null {
	if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === value)) {
		return `${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`;
	}
	const types = typeof schema.type === "string" ? [schema.type] : (schema.type ?? []);
	if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
		return `${path}: expected type ${types.join("/")} but got ${jsonTypeOf(value)}`;
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) return `${path}: ${value} < minimum ${schema.minimum}`;
		if (schema.maximum !== undefined && value > schema.maximum) return `${path}: ${value} > maximum ${schema.maximum}`;
		const exMin = typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined;
		const exMax = typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined;
		if (exMin !== undefined && value <= exMin) return `${path}: ${value} <= exclusiveMinimum ${exMin}`;
		if (exMax !== undefined && value >= exMax) return `${path}: ${value} >= exclusiveMaximum ${exMax}`;
		return null;
	}
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) return `${path}: shorter than minLength ${schema.minLength}`;
		if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path}: longer than maxLength ${schema.maxLength}`;
		return null;
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) return `${path}: fewer than minItems ${schema.minItems}`;
		if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: more than maxItems ${schema.maxItems}`;
		if (schema.items) for (let i = 0; i < value.length; i++) {
			const err = checkValue(value[i], schema.items, `${path}[${i}]`);
			if (err) return err;
		}
		return null;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) if (!(key in record)) return `${path ? `${path}.` : ""}${key}: missing required field`;
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
 * @returns null when the args pass the light checks; otherwise a human-readable
 * reason naming the offending/missing field (caller turns it into a re-issuable error result).
 */
export function precheckToolArguments(
	tool: { name: string; parameters?: unknown },
	toolCall: { name: string; arguments?: unknown },
): string | null {
	const args = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) return `arguments: expected an object for tool "${tool.name}"`;
	const schema = tool.parameters as PrecheckSchema | undefined;
	if (!schema || typeof schema !== "object") return null;
	try {
		const reason = checkValue(args, schema, "");
		return reason ? `Invalid arguments for tool "${toolCall.name}": ${reason}. Re-issue the tool call with complete arguments.` : null;
	} catch {
		return null;
	}
}
