import { repairJson } from "./json-parse.ts";

/**
 * Deterministic recovery of tool arguments that reached us in the wrong JSON shape.
 *
 * Some models (and some gateways in front of them) hand a nested array or object over as a
 * *string* holding its JSON, which then fails schema validation with a misleading type error.
 * This walks the tool's own schema and replaces such a value with the parsed container, and
 * nothing else: it never adds a field, never fills a missing value, never completes truncated
 * JSON, and never touches a string the schema declares as a string. When nothing matches, the
 * original reference is returned so callers can tell that no change happened.
 */

interface SchemaNode {
	type?: string | string[];
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	anyOf?: SchemaNode[];
	oneOf?: SchemaNode[];
}

const MAX_DEPTH = 32;

function declaredKinds(node: SchemaNode | undefined): string[] {
	if (!node) return [];
	const kinds: string[] = [];
	const collect = (candidate: SchemaNode) => {
		if (typeof candidate.type === "string") kinds.push(candidate.type);
		else if (Array.isArray(candidate.type)) kinds.push(...candidate.type);
		for (const branch of candidate.anyOf ?? []) collect(branch);
		for (const branch of candidate.oneOf ?? []) collect(branch);
	};
	collect(node);
	return kinds;
}

/** Parses only when the text really is the container the schema asks for; otherwise returns undefined. */
function parseAsDeclaredContainer(text: string, kinds: string[]): unknown[] | Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) return undefined;
	const candidates: unknown[] = [];
	try {
		candidates.push(JSON.parse(trimmed));
	} catch {
		const repaired = repairJson(trimmed);
		if (repaired === trimmed) return undefined;
		try {
			candidates.push(JSON.parse(repaired));
		} catch {
			return undefined;
		}
	}
	for (const candidate of candidates) {
		if (Array.isArray(candidate) && kinds.includes("array")) return candidate;
		if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) && kinds.includes("object"))
			return candidate as Record<string, unknown>;
	}
	return undefined;
}

function coerceNode(value: unknown, node: SchemaNode | undefined, depth: number): unknown {
	if (depth > MAX_DEPTH) return value;
	if (typeof value === "string") {
		const parsed = parseAsDeclaredContainer(value, declaredKinds(node));
		return parsed === undefined ? value : coerceNode(parsed, node, depth + 1);
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const coerced = coerceNode(item, node?.items, depth + 1);
			if (coerced !== item) changed = true;
			return coerced;
		});
		return changed ? next : value;
	}
	if (value !== null && typeof value === "object") {
		const properties = node?.properties;
		if (!properties) return value;
		const record = value as Record<string, unknown>;
		let changed = false;
		const next: Record<string, unknown> = { ...record };
		for (const [key, sub] of Object.entries(properties)) {
			if (!(key in record)) continue;
			const coerced = coerceNode(record[key], sub, depth + 1);
			if (coerced !== record[key]) {
				next[key] = coerced;
				changed = true;
			}
		}
		return changed ? next : value;
	}
	return value;
}

/**
 * Returns `args` with schema-declared containers restored from a JSON string, or the very same
 * `args` reference when nothing needed recovery.
 */
export function coerceToolArgumentsBySchema<T>(schema: unknown, args: T): T {
	if (!schema || typeof schema !== "object") return args;
	if (!args || typeof args !== "object") return args;
	return coerceNode(args, schema as SchemaNode, 0) as T;
}
